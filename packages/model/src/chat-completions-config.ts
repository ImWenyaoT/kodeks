import {
  DEFAULT_CHAT_COMPLETIONS_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  type RuntimeEnv,
} from "./factory";

export type ChatCompletionsConfig = {
  apiKey?: string;
  baseURL: string;
  model: string;
  missing: string[];
};

// 读取 Chat Completions key；本机开发 endpoint 可自动使用占位 key。
export function readChatCompletionsApiKey(env: RuntimeEnv): string | undefined {
  const localBaseURL = isLocalHttpURL(readChatCompletionsBaseURL(env));
  return (
    env.KODEKS_CHAT_COMPLETIONS_API_KEY ??
    (localBaseURL ? "not-needed" : undefined)
  );
}

// 读取 DeepSeek-first Chat Completions base URL。
export function readChatCompletionsBaseURL(env: RuntimeEnv): string {
  return (
    env.KODEKS_CHAT_COMPLETIONS_BASE_URL ?? DEFAULT_CHAT_COMPLETIONS_BASE_URL
  );
}

// 读取 DeepSeek-first Chat Completions 模型 ID。
export function readChatCompletionsModel(env: RuntimeEnv): string {
  return env.KODEKS_CHAT_COMPLETIONS_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
}

// 读取 MoonBridge 上游配置，并列出会导致实际请求失败的缺失项。
export function readChatCompletionsConfig(
  env: RuntimeEnv,
): ChatCompletionsConfig {
  const apiKey = readChatCompletionsApiKey(env);
  const baseURL = readChatCompletionsBaseURL(env);
  const model = readChatCompletionsModel(env);
  const missing: string[] = [];

  if (apiKey === undefined || apiKey.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_API_KEY");
  }
  if (baseURL.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_BASE_URL");
  }
  if (model.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_MODEL");
  }

  return { apiKey, baseURL, model, missing };
}

// 记录托管 bridge 的上游配置指纹；切换模型或 endpoint 时需要重启 bridge。
export function readChatCompletionsSignature(env: RuntimeEnv): string {
  return JSON.stringify({
    apiKey: readChatCompletionsApiKey(env) ?? "",
    baseURL: readChatCompletionsBaseURL(env),
    model: readChatCompletionsModel(env),
  });
}

// 判断 endpoint 是否是本机无鉴权开发服务。
export function isLocalHttpURL(value: string | undefined): boolean {
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
