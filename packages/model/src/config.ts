import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import type { RuntimeEnv } from "./factory";

type EndpointConfig = {
  apiKey?: unknown;
  baseURL?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
};

type BridgeConfig = EndpointConfig & {
  enabled?: unknown;
};

type ProviderConfig = EndpointConfig & {
  api?: unknown;
  models?: Array<{
    id?: unknown;
    name?: unknown;
  }>;
};

type ModelConfigFile = {
  env?: Record<string, unknown>;
  model?: {
    primary?: unknown;
    provider?: unknown;
    responses?: EndpointConfig;
    openai?: EndpointConfig;
    chatCompletions?: EndpointConfig;
    bridge?: BridgeConfig;
    moonbridge?: BridgeConfig;
    deepseek?: EndpointConfig;
    providers?: Record<string, ProviderConfig>;
  };
  models?: {
    providers?: Record<string, ProviderConfig>;
  };
  embeddings?: EndpointConfig & {
    enabled?: unknown;
    provider?: unknown;
  };
};

export type ConfiguredModelApi = "responses" | "chat-completions";

export type ConfiguredModelOption = {
  ref: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  api: ConfiguredModelApi;
  requiresBridge: boolean;
  baseURL?: string;
  configured: boolean;
};

export type ConfiguredModelCatalog = {
  primary?: string;
  models: ConfiguredModelOption[];
};

const CONFIG_FILE_NAME = "config.json";
const CONFIG_DIR_NAME = ".kodeks";

// 加载 repo 外的 Kodeks 模型配置，并让显式环境变量拥有最终覆盖权。
export function loadModelRuntimeEnv(
  env: RuntimeEnv = process.env,
  requestedModelRef?: unknown,
): RuntimeEnv {
  return {
    ...readModelConfigEnv(env, requestedModelRef),
    ...env,
  };
}

// 解析 Kodeks 用户级配置路径；测试和脚本可用 KODEKS_CONFIG_PATH 覆盖。
export function resolveKodeksConfigPath(env: RuntimeEnv = process.env): string {
  if (env.KODEKS_CONFIG_PATH?.trim()) {
    return resolve(env.KODEKS_CONFIG_PATH);
  }
  const canonical = join(resolveKodeksConfigDir(env), CONFIG_FILE_NAME);
  if (existsSync(canonical) || env.KODEKS_CONFIG_DIR?.trim()) {
    return canonical;
  }
  return (
    resolveLegacyKodeksConfigCandidates(env).find((path) => existsSync(path)) ??
    canonical
  );
}

// 解析 Kodeks 的用户级配置目录；默认采用 agent/CLI 友好的 ~/.kodeks。
export function resolveKodeksConfigDir(env: RuntimeEnv = process.env): string {
  const override = env.KODEKS_CONFIG_DIR?.trim();
  if (override) {
    return resolve(override);
  }
  return join(homedir(), CONFIG_DIR_NAME);
}

// 返回早期 Application Support/XDG/Roaming 路径，用于无痛读取旧安装留下的配置。
function resolveLegacyKodeksConfigCandidates(env: RuntimeEnv): string[] {
  if (platform() === "darwin") {
    return [
      join(
        homedir(),
        "Library",
        "Application Support",
        "kodeks",
        CONFIG_FILE_NAME,
      ),
    ];
  }

  if (platform() === "win32") {
    const appData =
      env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
    return [join(appData, "kodeks", CONFIG_FILE_NAME)];
  }

  const xdgConfigHome =
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [join(xdgConfigHome, "kodeks", CONFIG_FILE_NAME)];
}

// 读取 JSON 配置并转换成既有 env contract，避免 provider resolver 关心文件格式。
function readModelConfigEnv(
  env: RuntimeEnv,
  requestedModelRef?: unknown,
): RuntimeEnv {
  const path = resolveKodeksConfigPath(env);
  if (!existsSync(path)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelConfigFile;
  return modelConfigToEnv(resolveConfigEnvVars(parsed, env), requestedModelRef);
}

// 把用户级 JSON 配置映射到 runtime env 名称，兼容 OpenAI 和通用 endpoint 语义。
function modelConfigToEnv(
  config: ModelConfigFile,
  requestedModelRef?: unknown,
): RuntimeEnv {
  const model = config.model;
  const values: RuntimeEnv = {};
  writeEnvSection(values, config.env);
  if (model !== undefined) {
    writeString(
      values,
      "KODEKS_MODEL_PROVIDER",
      normalizeProvider(model.provider),
    );
    writeEndpoint(values, "KODEKS_RESPONSES", model.responses ?? model.openai);
    writeEndpoint(values, "KODEKS_CHAT_COMPLETIONS", model.chatCompletions);
    writeBridge(values, model.bridge ?? model.moonbridge);
    writeEndpoint(values, "DEEPSEEK", model.deepseek);
    writeSelectedProvider(
      values,
      model,
      config.models?.providers,
      requestedModelRef,
    );
  } else {
    writeSelectedProvider(
      values,
      undefined,
      config.models?.providers,
      requestedModelRef,
    );
  }
  writeEmbeddings(values, config.embeddings);
  return values;
}

// 列出用户配置文件中可供前端选择的 provider/model 组合。
export function loadConfiguredModelCatalog(
  env: RuntimeEnv = process.env,
): ConfiguredModelCatalog {
  const path = resolveKodeksConfigPath(env);
  if (!existsSync(path)) {
    return { models: [] };
  }
  const config = resolveConfigEnvVars(
    JSON.parse(readFileSync(path, "utf8")) as ModelConfigFile,
    env,
  );
  const providers = config.model?.providers ?? config.models?.providers ?? {};
  const models = Object.entries(providers).flatMap(([providerId, provider]) =>
    configuredModelsFromProvider(providerId, provider),
  );
  return {
    primary: stringValue(config.model?.primary),
    models,
  };
}

// 规范化用户配置里的 provider 命名；对外只暴露 Responses 和 Chat Completions 两条协议路径。
function normalizeProvider(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value === "responses") {
    return "openai";
  }
  if (value === "chat-completions" || value === "deepseek") {
    return "moonbridge";
  }
  return value;
}

// 将 OpenClaw 风格的 provider registry 映射到 Kodeks 当前的 Responses/MoonBridge runtime。
function writeSelectedProvider(
  values: RuntimeEnv,
  model: ModelConfigFile["model"] | undefined,
  rootProviders: Record<string, ProviderConfig> | undefined,
  requestedModelRef?: unknown,
): void {
  const providers = model?.providers ?? rootProviders;
  const selection = resolveSelectedProvider(
    model,
    providers,
    requestedModelRef,
  );
  if (selection === undefined) {
    return;
  }
  const api = normalizeApiShape(selection.provider.api);
  const endpoint = {
    ...selection.provider,
    model: selection.provider.model ?? selection.modelId,
  };
  if (api === "responses") {
    values.KODEKS_MODEL_PROVIDER = "openai";
    writeEndpoint(values, "KODEKS_RESPONSES", endpoint);
    return;
  }
  if (api === "chat-completions") {
    values.KODEKS_MODEL_PROVIDER = "moonbridge";
    writeEndpoint(values, "KODEKS_CHAT_COMPLETIONS", endpoint);
  }
}

// 解析 primary/provider 指向的 provider 配置，并从 provider/model 引用中取出模型 id。
function resolveSelectedProvider(
  model: ModelConfigFile["model"] | undefined,
  providers: Record<string, ProviderConfig> | undefined,
  requestedModelRef?: unknown,
):
  | {
      providerId: string;
      provider: ProviderConfig;
      modelId?: string;
    }
  | undefined {
  if (providers === undefined) {
    return undefined;
  }
  const primary = stringValue(requestedModelRef) ?? stringValue(model?.primary);
  const providerName = stringValue(model?.provider);
  const fromPrimary = splitModelRef(primary);
  const providerId = fromPrimary?.providerId ?? providerName;
  if (providerId === undefined) {
    return undefined;
  }
  const provider = providers[providerId];
  if (provider === undefined) {
    return undefined;
  }
  return {
    providerId,
    provider,
    modelId:
      fromPrimary?.modelId ??
      stringValue(provider.model) ??
      firstConfiguredModelId(provider),
  };
}

// 将一个 provider 下的模型清单展开成前端可展示的 provider/model refs。
function configuredModelsFromProvider(
  providerId: string,
  provider: ProviderConfig,
): ConfiguredModelOption[] {
  const api = normalizeApiShape(provider.api);
  if (api === undefined) {
    return [];
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const explicitModels = models.flatMap((model) => {
    const modelId = stringValue(model.id);
    if (modelId === undefined) {
      return [];
    }
    return [
      createConfiguredModelOption({
        providerId,
        provider,
        api,
        modelId,
        modelName: stringValue(model.name) ?? modelId,
      }),
    ];
  });
  const fallbackModelId = stringValue(provider.model);
  if (explicitModels.length > 0 || fallbackModelId === undefined) {
    return explicitModels;
  }
  return [
    createConfiguredModelOption({
      providerId,
      provider,
      api,
      modelId: fallbackModelId,
      modelName: fallbackModelId,
    }),
  ];
}

// 创建一个不包含 secret 的模型展示项，并标记它是否已有最低限度 endpoint 配置。
function createConfiguredModelOption(input: {
  providerId: string;
  provider: ProviderConfig;
  api: ConfiguredModelApi;
  modelId: string;
  modelName: string;
}): ConfiguredModelOption {
  const baseURL = stringValue(input.provider.baseURL);
  const apiKey = stringValue(input.provider.apiKey);
  const localNoAuthEndpoint = isLocalHttpURL(baseURL);
  return {
    ref: `${input.providerId}/${input.modelId}`,
    providerId: input.providerId,
    providerName: input.providerId,
    modelId: input.modelId,
    modelName: input.modelName,
    api: input.api,
    requiresBridge: input.api === "chat-completions",
    ...(baseURL === undefined ? {} : { baseURL }),
    configured:
      input.api === "responses"
        ? baseURL !== undefined || apiKey !== undefined
        : baseURL !== undefined &&
          (apiKey !== undefined || localNoAuthEndpoint),
  };
}

// 只把本机 HTTP endpoint 视为可无 key 运行，避免云端 Chat Completions 配置误报可用。
function isLocalHttpURL(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

// 拆分 provider/model 形式的模型引用，保持 provider 名称和真实模型 id 解耦。
function splitModelRef(value: string | undefined):
  | {
      providerId: string;
      modelId: string;
    }
  | undefined {
  if (value === undefined) {
    return undefined;
  }
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) {
    return undefined;
  }
  return {
    providerId: value.slice(0, index),
    modelId: value.slice(index + 1),
  };
}

// 读取 provider.models[] 中的第一个显式模型 id，作为未设置 primary 时的保守 fallback。
function firstConfiguredModelId(provider: ProviderConfig): string | undefined {
  const first = provider.models?.[0];
  return stringValue(first?.id);
}

// 将配置中的 API 名称归一成 Kodeks 目前真正区分的两类协议形态。
function normalizeApiShape(
  value: unknown,
): "responses" | "chat-completions" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (
    value === "responses" ||
    value === "openai-responses" ||
    value === "openai-codex-responses" ||
    value === "azure-openai-responses"
  ) {
    return "responses";
  }
  if (
    value === "chat-completions" ||
    value === "openai-completions" ||
    value === "completions"
  ) {
    return "chat-completions";
  }
  return undefined;
}

// 写入一个 OpenAI-compatible endpoint 的三件套：key、baseURL 和 model。
function writeEndpoint(
  values: RuntimeEnv,
  prefix: string,
  endpoint: EndpointConfig | undefined,
): void {
  if (endpoint === undefined) {
    return;
  }
  writeString(values, `${prefix}_API_KEY`, endpoint.apiKey);
  writeString(values, `${prefix}_BASE_URL`, endpoint.baseURL);
  writeString(values, `${prefix}_MODEL`, endpoint.model);
  writeString(values, `${prefix}_REASONING_EFFORT`, endpoint.reasoningEffort);
}

// 写入本地 MoonBridge 自身的监听配置；上游 Chat Completions 配置独立保存。
function writeBridge(
  values: RuntimeEnv,
  bridge: BridgeConfig | undefined,
): void {
  if (bridge === undefined) {
    return;
  }
  if (typeof bridge.enabled === "boolean") {
    values.KODEKS_BRIDGE_ENABLED = String(bridge.enabled);
  }
  writeString(values, "KODEKS_BRIDGE_API_KEY", bridge.apiKey);
  writeString(values, "KODEKS_BRIDGE_BASE_URL", bridge.baseURL);
  writeString(values, "KODEKS_BRIDGE_MODEL", bridge.model);
  writeString(values, "KODEKS_BRIDGE_REASONING_EFFORT", bridge.reasoningEffort);
}

// 写入 memory embedding 的 OpenAI-compatible 配置，供 storage runtime 复用同一份用户配置。
function writeEmbeddings(
  values: RuntimeEnv,
  embeddings: ModelConfigFile["embeddings"],
): void {
  if (embeddings === undefined) {
    return;
  }
  if (typeof embeddings.enabled === "boolean") {
    values.KODEKS_EMBEDDINGS_ENABLED = String(embeddings.enabled);
  }
  const provider = stringValue(embeddings.provider) ?? "openai-compatible";
  writeString(values, "KODEKS_EMBEDDINGS_PROVIDER", provider);
  if (
    provider === "lmstudio" ||
    provider === "lm-studio" ||
    provider === "openai-compatible" ||
    provider === "openai"
  ) {
    writeString(values, "KODEKS_OPENAI_COMPAT_BASE_URL", embeddings.baseURL);
    writeString(values, "KODEKS_OPENAI_COMPAT_API_KEY", embeddings.apiKey);
    writeString(values, "KODEKS_OPENAI_COMPAT_EMBED_MODEL", embeddings.model);
  } else if (provider === "ollama") {
    writeString(values, "KODEKS_OLLAMA_BASE_URL", embeddings.baseURL);
    writeString(values, "KODEKS_OLLAMA_EMBED_MODEL", embeddings.model);
  } else if (provider === "huggingface" || provider === "hf") {
    writeString(values, "KODEKS_HUGGINGFACE_BASE_URL", embeddings.baseURL);
    writeString(values, "KODEKS_HUGGINGFACE_API_TOKEN", embeddings.apiKey);
    writeString(values, "KODEKS_HUGGINGFACE_EMBED_MODEL", embeddings.model);
  }
}

// 允许 config.env 写入默认 env，但真实进程 env 仍会在 loadModelRuntimeEnv 末尾覆盖它。
function writeEnvSection(
  values: RuntimeEnv,
  env: Record<string, unknown> | undefined,
): void {
  if (env === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    writeString(values, key, value);
  }
}

// 递归替换 ${VAR_NAME}，让用户配置可以引用 shell/secret manager 注入的 secret。
function resolveConfigEnvVars<T>(value: T, env: RuntimeEnv): T {
  if (typeof value === "string") {
    return value.replaceAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (token, key) => {
      const replacement = env[key];
      return replacement === undefined || replacement.length === 0
        ? token
        : replacement;
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveConfigEnvVars(entry, env)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveConfigEnvVars(entry, env),
      ]),
    ) as T;
  }
  return value;
}

// 只写入非空字符串，避免把 undefined/null 变成危险的字面量配置。
function writeString(values: RuntimeEnv, key: string, value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    values[key] = value;
  }
}

// 把 unknown 收窄成非空字符串，避免把 null/number/object 写进 env contract。
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
