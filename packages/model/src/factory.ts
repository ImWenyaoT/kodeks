import { DeepSeekChatCompletionsClient } from './providers/deepseek-chat';
import { OpenAIResponsesClient } from './providers/openai-responses';
import type {
  ModelClient,
  ModelProvider,
  ModelProviderOverride,
  ReasoningEffort
} from './types';

export type RuntimeEnv = Record<string, string | undefined>;

export type ModelClientOptions =
  | {
      provider: Extract<ModelProvider, 'bridge' | 'moonbridge'>;
      apiKey: string;
      baseURL: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    }
  | {
      provider: Extract<ModelProvider, 'deepseek'>;
      apiKey: string;
      baseURL: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    }
  | {
      provider: Extract<ModelProvider, 'openai'>;
      apiKey: string;
      baseURL?: string;
      model: string;
      reasoningEffort: ReasoningEffort;
    };

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro';
const DEFAULT_DEEPSEEK_REASONING_EFFORT: ReasoningEffort = 'high';
const DEFAULT_BRIDGE_API_KEY = 'bridge';
const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:38440/v1';
const DEFAULT_BRIDGE_MODEL = 'bridge';
const DEFAULT_BRIDGE_REASONING_EFFORT: ReasoningEffort = 'high';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_REASONING_EFFORT: ReasoningEffort = 'medium';
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh'
]);

// 从环境变量创建模型客户端；内置 bridge 可把 DeepSeek 重新接回 Responses API。
export function createModelClientFromEnv(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown,
  requestedProvider?: unknown
): ModelClient | null {
  const options = resolveModelClientOptions(
    env,
    requestedReasoningEffort,
    requestedProvider
  );
  if (options === null) {
    return null;
  }

  if (options.provider === 'deepseek') {
    return new DeepSeekChatCompletionsClient(options);
  }

  return new OpenAIResponsesClient(options);
}

// 解析模型配置；保持纯函数，方便 web runtime 和单元测试复用。
export function resolveModelClientOptions(
  env: RuntimeEnv = process.env,
  requestedReasoningEffort?: unknown,
  requestedProvider?: unknown
): ModelClientOptions | null {
  const providerOverride = resolveProviderOverride(requestedProvider);
  if (providerOverride === 'openai') {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (providerOverride === 'moonbridge') {
    return resolveBridgeOptions(
      { ...env, KODEKS_MODEL_PROVIDER: 'moonbridge' },
      requestedReasoningEffort
    );
  }

  if (providerOverride === 'deepseek') {
    return resolveDeepSeekOptions(env, requestedReasoningEffort);
  }

  if (env.KODEKS_MODEL_PROVIDER === 'openai') {
    return resolveOpenAIOptions(env, requestedReasoningEffort);
  }

  if (env.KODEKS_MODEL_PROVIDER === 'deepseek') {
    return resolveDeepSeekOptions(env, requestedReasoningEffort);
  }

  if (shouldUseBridge(env)) {
    return resolveBridgeOptions(env, requestedReasoningEffort);
  }

  return (
    resolveOpenAIOptions(env, requestedReasoningEffort) ??
    resolveDeepSeekOptions(env, requestedReasoningEffort)
  );
}

// 解析内置 Responses bridge 配置；本地 bridge 通常不需要真实客户端 API key。
function resolveBridgeOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown
): ModelClientOptions {
  return {
    provider:
      env.KODEKS_MODEL_PROVIDER === 'moonbridge' ? 'moonbridge' : 'bridge',
    apiKey:
      env.KODEKS_BRIDGE_API_KEY ??
      env.MOONBRIDGE_API_KEY ??
      DEFAULT_BRIDGE_API_KEY,
    baseURL:
      env.KODEKS_BRIDGE_BASE_URL ??
      env.MOONBRIDGE_BASE_URL ??
      DEFAULT_BRIDGE_BASE_URL,
    model:
      env.KODEKS_BRIDGE_MODEL ?? env.MOONBRIDGE_MODEL ?? DEFAULT_BRIDGE_MODEL,
    reasoningEffort: resolveReasoningEffort(
      requestedReasoningEffort,
      env.KODEKS_BRIDGE_REASONING_EFFORT ?? env.MOONBRIDGE_REASONING_EFFORT,
      DEFAULT_BRIDGE_REASONING_EFFORT
    )
  };
}

// 解析 DeepSeek 直连 Chat Completions 配置。
function resolveDeepSeekOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown
): ModelClientOptions | null {
  if (env.DEEPSEEK_API_KEY) {
    return {
      provider: 'deepseek',
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
function resolveOpenAIOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown
): ModelClientOptions | null {
  if (env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
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

// 判断是否启用 Responses bridge；保留 MOONBRIDGE_* 作为旧配置兼容。
function shouldUseBridge(env: RuntimeEnv): boolean {
  return (
    env.KODEKS_MODEL_PROVIDER === 'bridge' ||
    env.KODEKS_MODEL_PROVIDER === 'moonbridge' ||
    env.KODEKS_BRIDGE_ENABLED === 'true' ||
    env.MOONBRIDGE_ENABLED === 'true' ||
    env.KODEKS_BRIDGE_BASE_URL !== undefined ||
    env.MOONBRIDGE_BASE_URL !== undefined
  );
}

// 解析请求级和环境变量级 reasoning effort，并回退到 provider 默认值。
function resolveReasoningEffort(
  requested: unknown,
  configured: string | undefined,
  fallback: ReasoningEffort
): ReasoningEffort {
  if (typeof requested === 'string' && isReasoningEffort(requested)) {
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

// 把松散请求参数收窄为工作台允许覆盖的 provider，避免暴露内部 bridge 别名。
function resolveProviderOverride(
  requestedProvider: unknown
): ModelProviderOverride | null {
  if (
    requestedProvider === 'openai' ||
    requestedProvider === 'moonbridge' ||
    requestedProvider === 'deepseek'
  ) {
    return requestedProvider;
  }

  return null;
}
