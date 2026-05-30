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

  if (
    env.KODEKS_MODEL_PROVIDER === "openai" ||
    env.KODEKS_MODEL_PROVIDER === "responses"
  ) {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (env.KODEKS_MODEL_PROVIDER === "deepseek") {
    return resolveBridgeOptions(
      { ...env, KODEKS_MODEL_PROVIDER: "moonbridge" },
      requestedReasoningEffort,
    );
  }

  if (env.KODEKS_MODEL_PROVIDER === "chat-completions") {
    return resolveBridgeOptions(
      { ...env, KODEKS_MODEL_PROVIDER: "moonbridge" },
      requestedReasoningEffort,
    );
  }

  if (shouldUseBridge(env)) {
    return resolveBridgeOptions(env, requestedReasoningEffort);
  }

  return (
    resolveOpenAIOptions(env, requestedReasoningEffort) ??
    resolveLegacyChatCompletionsOptions(env, requestedReasoningEffort)
  );
}

// 解析内置 Responses bridge 配置；本地 bridge 通常不需要真实客户端 API key。
function resolveBridgeOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): ModelClientOptions {
  return {
    provider: "moonbridge",
    apiKey:
      env.KODEKS_BRIDGE_API_KEY ??
      env.MOONBRIDGE_API_KEY ??
      DEFAULT_BRIDGE_API_KEY,
    baseURL: trimTrailingSlash(
      env.KODEKS_BRIDGE_BASE_URL ??
        env.MOONBRIDGE_BASE_URL ??
        DEFAULT_BRIDGE_BASE_URL,
    ),
    model:
      env.KODEKS_BRIDGE_MODEL ?? env.MOONBRIDGE_MODEL ?? DEFAULT_BRIDGE_MODEL,
    reasoningEffort: resolveReasoningEffort(
      requestedReasoningEffort,
      env.KODEKS_BRIDGE_REASONING_EFFORT ?? env.MOONBRIDGE_REASONING_EFFORT,
      DEFAULT_BRIDGE_REASONING_EFFORT,
    ),
  };
}

// 解析历史 DeepSeek env，并把它当作 Chat Completions endpoint 交给 MoonBridge。
function resolveLegacyChatCompletionsOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): ModelClientOptions | null {
  if (env.DEEPSEEK_API_KEY) {
    return resolveBridgeOptions(
      {
        ...env,
        KODEKS_MODEL_PROVIDER: "moonbridge",
        KODEKS_BRIDGE_REASONING_EFFORT:
          env.KODEKS_BRIDGE_REASONING_EFFORT ??
          env.MOONBRIDGE_REASONING_EFFORT ??
          env.DEEPSEEK_REASONING_EFFORT,
      },
      requestedReasoningEffort,
    );
  }

  return null;
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

// 判断是否启用 Responses bridge；保留 MOONBRIDGE_* 作为旧配置兼容。
function shouldUseBridge(env: RuntimeEnv): boolean {
  return (
    env.KODEKS_MODEL_PROVIDER === "bridge" ||
    env.KODEKS_MODEL_PROVIDER === "moonbridge" ||
    env.KODEKS_BRIDGE_ENABLED === "true" ||
    env.MOONBRIDGE_ENABLED === "true" ||
    env.KODEKS_CHAT_COMPLETIONS_API_KEY !== undefined ||
    env.KODEKS_CHAT_COMPLETIONS_BASE_URL !== undefined ||
    env.KODEKS_CHAT_COMPLETIONS_MODEL !== undefined ||
    env.KODEKS_BRIDGE_BASE_URL !== undefined ||
    env.MOONBRIDGE_BASE_URL !== undefined
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
  if (requestedProvider === "responses") {
    return "openai";
  }

  if (requestedProvider === "openai" || requestedProvider === "moonbridge") {
    return requestedProvider;
  }

  if (requestedProvider === "bridge") {
    return "moonbridge";
  }

  if (
    requestedProvider === "deepseek" ||
    requestedProvider === "chat-completions"
  ) {
    return "moonbridge";
  }

  return null;
}

// 移除 URL 末尾斜杠，避免 SDK 或脚本拼接出双斜杠路径。
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
