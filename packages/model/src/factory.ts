import { DeepSeekChatCompletionsClient } from "./providers/deepseek-chat";
import { OpenAIResponsesClient } from "./providers/openai-responses";
import type { ModelClient, ReasoningEffort } from "./types";

export type RuntimeEnv = Record<string, string | undefined>;

export type ModelClientOptions =
  | {
      provider: "moonbridge";
      apiKey: string;
      baseURL: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    }
  | {
      provider: "deepseek";
      apiKey: string;
      baseURL: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    }
  | {
      provider: "openai";
      apiKey: string;
      baseURL?: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    };

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEFAULT_DEEPSEEK_REASONING_EFFORT: ReasoningEffort = "high";
const DEFAULT_MOONBRIDGE_API_KEY = "moonbridge";
const DEFAULT_MOONBRIDGE_BASE_URL = "http://127.0.0.1:38440/v1";
const DEFAULT_MOONBRIDGE_MODEL = "moonbridge";
const DEFAULT_MOONBRIDGE_REASONING_EFFORT: ReasoningEffort = "high";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_REASONING_EFFORT: ReasoningEffort = "medium";
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh"]);

// 从环境变量创建模型客户端；Moon Bridge 可把 DeepSeek 重新接回 Responses API。
export function createModelClientFromEnv(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown
): ModelClient | null {
  const options = resolveModelClientOptions(env, requestedReasoningEffort);
  if (options === null) {
    return null;
  }

  if (options.provider === "deepseek") {
    return new DeepSeekChatCompletionsClient(options);
  }

  return new OpenAIResponsesClient(options);
}

// 解析模型配置；保持纯函数，方便 web runtime 和单元测试复用。
export function resolveModelClientOptions(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown
): ModelClientOptions | null {
  if (env.KODEKS_MODEL_PROVIDER === "openai") {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (env.KODEKS_MODEL_PROVIDER === "deepseek") {
    return resolveDeepSeekOptions(env, requestedReasoningEffort);
  }

  if (shouldUseMoonBridge(env)) {
    return resolveMoonBridgeOptions(env, requestedReasoningEffort);
  }

  return resolveDeepSeekOptions(env, requestedReasoningEffort) ?? resolveOpenAIOptions(env, requestedReasoningEffort);
}

// 解析 Moon Bridge Responses 配置；Moon Bridge 本地代理通常不需要真实 API key。
function resolveMoonBridgeOptions(env: RuntimeEnv, requestedReasoningEffort: unknown): ModelClientOptions {
  return {
    provider: "moonbridge",
    apiKey: env.MOONBRIDGE_API_KEY ?? DEFAULT_MOONBRIDGE_API_KEY,
    baseURL: env.MOONBRIDGE_BASE_URL ?? DEFAULT_MOONBRIDGE_BASE_URL,
    model: env.MOONBRIDGE_MODEL ?? DEFAULT_MOONBRIDGE_MODEL,
    reasoningEffort: resolveReasoningEffort(
      requestedReasoningEffort,
      env.MOONBRIDGE_REASONING_EFFORT,
      DEFAULT_MOONBRIDGE_REASONING_EFFORT
    )
  };
}

// 解析 DeepSeek 直连 Chat Completions 配置。
function resolveDeepSeekOptions(env: RuntimeEnv, requestedReasoningEffort: unknown): ModelClientOptions | null {
  if (env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      apiKey: env.DEEPSEEK_API_KEY,
      baseURL: env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL,
      reasoningEffort: resolveReasoningEffort(
        requestedReasoningEffort,
        env.DEEPSEEK_REASONING_EFFORT,
        DEFAULT_DEEPSEEK_REASONING_EFFORT
      )
    };
  }

  return null;
}

// 解析 OpenAI 原生 Responses 配置。
function resolveOpenAIOptions(env: RuntimeEnv, requestedReasoningEffort: unknown): ModelClientOptions | null {
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
      reasoningEffort: resolveReasoningEffort(
        requestedReasoningEffort,
        env.OPENAI_REASONING_EFFORT,
        DEFAULT_OPENAI_REASONING_EFFORT
      )
    };
  }

  return null;
}

// 判断是否启用 Moon Bridge；显式 provider、开关或 base url 任一存在即可。
function shouldUseMoonBridge(env: RuntimeEnv): boolean {
  return env.KODEKS_MODEL_PROVIDER === "moonbridge" || env.MOONBRIDGE_ENABLED === "true" || env.MOONBRIDGE_BASE_URL !== undefined;
}

// 解析请求级和环境变量级 reasoning effort，并回退到 provider 默认值。
function resolveReasoningEffort(requested: unknown, configured: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
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
