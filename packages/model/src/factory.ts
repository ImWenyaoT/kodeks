import { OpenAIResponsesClient } from "./providers/openai-responses";
import type {
  ModelClient,
  ModelProvider,
  ModelProviderOverride,
  ReasoningEffort,
} from "./types";

export type RuntimeEnv = Record<string, string | undefined>;

export type ModelClientOptions =
  | {
      provider: Extract<ModelProvider, "moonbridge">;
      apiKey: string;
      baseURL: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    }
  | {
      provider: Extract<ModelProvider, "openai">;
      apiKey: string;
      baseURL?: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    };

const DEFAULT_BRIDGE_API_KEY = "bridge";
const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:38440/v1";
const DEFAULT_BRIDGE_MODEL = "bridge";
const DEFAULT_BRIDGE_REASONING_EFFORT: ReasoningEffort = "high";
export const DEFAULT_CHAT_COMPLETIONS_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_REASONING_EFFORT: ReasoningEffort = "medium";
const LOCAL_ENDPOINT_API_KEY = "not-needed";
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const DEPRECATED_ENV_MIGRATIONS: Record<string, string> = {
  DEEPSEEK_API_KEY: "KODEKS_CHAT_COMPLETIONS_API_KEY",
  DEEPSEEK_BASE_URL: "KODEKS_CHAT_COMPLETIONS_BASE_URL",
  DEEPSEEK_MODEL: "KODEKS_CHAT_COMPLETIONS_MODEL",
  DEEPSEEK_REASONING_EFFORT: "KODEKS_BRIDGE_REASONING_EFFORT",
  KODEKS_BRIDGE_DEEPSEEK_API_KEY: "KODEKS_CHAT_COMPLETIONS_API_KEY",
  KODEKS_BRIDGE_DEEPSEEK_BASE_URL: "KODEKS_CHAT_COMPLETIONS_BASE_URL",
  KODEKS_BRIDGE_DEEPSEEK_MODEL: "KODEKS_CHAT_COMPLETIONS_MODEL",
  MOONBRIDGE_API_KEY: "KODEKS_BRIDGE_API_KEY",
  MOONBRIDGE_BASE_URL: "KODEKS_BRIDGE_BASE_URL",
  MOONBRIDGE_ENABLED: "KODEKS_BRIDGE_ENABLED",
  MOONBRIDGE_MODEL: "KODEKS_BRIDGE_MODEL",
  MOONBRIDGE_REASONING_EFFORT: "KODEKS_BRIDGE_REASONING_EFFORT",
  MOONBRIDGE_DEEPSEEK_API_KEY: "KODEKS_CHAT_COMPLETIONS_API_KEY",
  MOONBRIDGE_DEEPSEEK_BASE_URL: "KODEKS_CHAT_COMPLETIONS_BASE_URL",
  MOONBRIDGE_DEEPSEEK_MODEL: "KODEKS_CHAT_COMPLETIONS_MODEL",
};
const DEPRECATED_PROVIDER_VALUES: Record<string, string> = {
  bridge: "moonbridge",
  deepseek: "moonbridge",
  "chat-completions": "moonbridge",
};
const PROVIDER_DECISION_ORDER: ModelProvider[] = ["moonbridge", "openai"];

export class ModelConfigurationError extends Error {
  readonly code = "model_configuration_error";

  // 创建带稳定错误码的配置错误，供 runtime 显示迁移指引。
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

// 从环境变量创建 Responses 客户端；Chat Completions endpoint 统一经 MoonBridge 暴露为 Responses。
export function createModelClientFromEnv(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown,
  requestedProvider?: unknown,
): ModelClient | null {
  const options = resolveModelClientOptions(
    env,
    requestedReasoningEffort,
    requestedProvider,
  );
  if (options === null) {
    return null;
  }

  return new OpenAIResponsesClient(options);
}

// 解析模型配置；保持纯函数，方便 web runtime 和单元测试复用。
export function resolveModelClientOptions(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown,
  requestedProvider?: unknown,
): ModelClientOptions | null {
  assertNoDeprecatedModelEnv(env);
  const providerOverride = resolveProviderOverride(requestedProvider);
  if (providerOverride === "openai") {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (providerOverride === "moonbridge") {
    return resolveBridgeOptions(
      { ...env, KODEKS_MODEL_PROVIDER: "moonbridge" },
      requestedReasoningEffort,
    );
  }

  const configuredProvider = resolveConfiguredProvider(
    env.KODEKS_MODEL_PROVIDER,
  );
  if (configuredProvider === "openai") {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (configuredProvider === "moonbridge") {
    return resolveBridgeOptions(env, requestedReasoningEffort);
  }

  for (const provider of PROVIDER_DECISION_ORDER) {
    const options =
      provider === "moonbridge"
        ? resolveBridgeOptionsIfConfigured(env, requestedReasoningEffort)
        : resolveOpenAIOptions(env, requestedReasoningEffort);
    if (options !== null) {
      return options;
    }
  }

  return null;
}

// 解析内置 Responses bridge 配置；本地 bridge 通常不需要真实客户端 API key。
function resolveBridgeOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): ModelClientOptions {
  return {
    provider: "moonbridge",
    apiKey: env.KODEKS_BRIDGE_API_KEY ?? DEFAULT_BRIDGE_API_KEY,
    baseURL: trimTrailingSlash(
      env.KODEKS_BRIDGE_BASE_URL ?? DEFAULT_BRIDGE_BASE_URL,
    ),
    model: env.KODEKS_BRIDGE_MODEL ?? DEFAULT_BRIDGE_MODEL,
    reasoningEffort: resolveReasoningEffort(
      requestedReasoningEffort,
      env.KODEKS_BRIDGE_REASONING_EFFORT,
      DEFAULT_BRIDGE_REASONING_EFFORT,
    ),
  };
}

// 只在 DeepSeek/MoonBridge 标准键存在时启用 Chat Completions 通道。
function resolveBridgeOptionsIfConfigured(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): ModelClientOptions | null {
  if (!shouldUseBridge(env)) {
    return null;
  }

  return resolveBridgeOptions(env, requestedReasoningEffort);
}

// 解析直连 Responses-compatible 配置；OpenAI 是默认官方实现。
function resolveOpenAIOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): ModelClientOptions | null {
  const apiKey =
    env.KODEKS_RESPONSES_API_KEY ??
    env.OPENAI_API_KEY ??
    (env.KODEKS_RESPONSES_BASE_URL === undefined
      ? undefined
      : LOCAL_ENDPOINT_API_KEY);

  if (apiKey) {
    return {
      provider: "openai",
      apiKey,
      baseURL: env.KODEKS_RESPONSES_BASE_URL ?? env.OPENAI_BASE_URL,
      model:
        env.KODEKS_RESPONSES_MODEL ?? env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      reasoningEffort: resolveReasoningEffort(
        requestedReasoningEffort,
        env.KODEKS_RESPONSES_REASONING_EFFORT ?? env.OPENAI_REASONING_EFFORT,
        DEFAULT_OPENAI_REASONING_EFFORT,
      ),
    };
  }

  return null;
}

// 判断是否启用 Responses bridge；DeepSeek-first 只看标准 KODEKS_* 键。
function shouldUseBridge(env: RuntimeEnv): boolean {
  return (
    env.KODEKS_MODEL_PROVIDER === "moonbridge" ||
    env.KODEKS_BRIDGE_ENABLED === "true" ||
    env.KODEKS_BRIDGE_API_KEY !== undefined ||
    env.KODEKS_CHAT_COMPLETIONS_API_KEY !== undefined ||
    env.KODEKS_CHAT_COMPLETIONS_BASE_URL !== undefined ||
    env.KODEKS_CHAT_COMPLETIONS_MODEL !== undefined ||
    env.KODEKS_BRIDGE_BASE_URL !== undefined ||
    env.KODEKS_BRIDGE_MODEL !== undefined
  );
}

// 解析请求级和环境变量级 reasoning effort，并回退到 provider 默认值。
function resolveReasoningEffort(
  requested: unknown,
  configured: string | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  if (typeof requested === "string" && isReasoningEffort(requested)) {
    return requested;
  }

  if (configured !== undefined && isReasoningEffort(configured)) {
    return configured;
  }

  return fallback;
}

// 判断字符串是否是 Kodeks 暴露给 UI 的 reasoning effort 值。
function isReasoningEffort(value: string): value is ReasoningEffort {
  return SUPPORTED_REASONING_EFFORTS.has(value as ReasoningEffort);
}

// 把松散请求参数收窄为工作台允许覆盖的 provider。
function resolveProviderOverride(
  requestedProvider: unknown,
): ModelProviderOverride | null {
  if (typeof requestedProvider !== "string") {
    return null;
  }

  if (requestedProvider === "openai" || requestedProvider === "moonbridge") {
    return requestedProvider;
  }

  if (requestedProvider in DEPRECATED_PROVIDER_VALUES) {
    throw new ModelConfigurationError(
      `Model provider "${requestedProvider}" has been removed. Use "${DEPRECATED_PROVIDER_VALUES[requestedProvider]}" instead.`,
    );
  }

  return null;
}

// 读取环境级 provider，并拒绝已下线 alias，避免静默切换模型通道。
function resolveConfiguredProvider(
  value: string | undefined,
): ModelProvider | null {
  if (value === undefined || value.length === 0) {
    return null;
  }
  if (value === "responses") {
    return "openai";
  }
  if (value === "openai" || value === "moonbridge") {
    return value;
  }
  if (value in DEPRECATED_PROVIDER_VALUES) {
    throw new ModelConfigurationError(
      `KODEKS_MODEL_PROVIDER="${value}" has been removed. Use "${DEPRECATED_PROVIDER_VALUES[value]}" instead.`,
    );
  }
  throw new ModelConfigurationError(
    `Unsupported KODEKS_MODEL_PROVIDER="${value}". Use "openai", "responses", or "moonbridge".`,
  );
}

// 拒绝旧入口名，并给出一对一迁移目标，避免旧 secret 继续改变运行时行为。
function assertNoDeprecatedModelEnv(env: RuntimeEnv): void {
  const deprecated = Object.entries(DEPRECATED_ENV_MIGRATIONS).find(
    ([key]) => env[key] !== undefined,
  );
  if (deprecated === undefined) {
    return;
  }
  const [from, to] = deprecated;
  throw new ModelConfigurationError(
    `${from} has been removed. Rename it to ${to}; Kodeks now only accepts KODEKS_* model configuration keys plus official OPENAI_* fallback keys.`,
  );
}

// 移除 URL 末尾斜杠，避免 SDK 或脚本拼接出双斜杠路径。
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
