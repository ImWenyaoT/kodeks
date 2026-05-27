import { afterEach, describe, expect, it } from "vitest";

import { createKodeksUIMessageResponse, resolveModelClientOptions, streamKodeksChat } from "./kodeks-runtime";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAIModel = process.env.OPENAI_MODEL;
const originalKodeksModelProvider = process.env.KODEKS_MODEL_PROVIDER;
const originalMoonBridgeEnabled = process.env.MOONBRIDGE_ENABLED;
const originalMoonBridgeKey = process.env.MOONBRIDGE_API_KEY;
const originalMoonBridgeBaseUrl = process.env.MOONBRIDGE_BASE_URL;
const originalMoonBridgeModel = process.env.MOONBRIDGE_MODEL;
const originalMoonBridgeReasoningEffort = process.env.MOONBRIDGE_REASONING_EFFORT;
const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const originalDeepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const originalDeepSeekModel = process.env.DEEPSEEK_MODEL;
const originalDeepSeekReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT;
const originalArkKey = process.env.ARK_API_KEY;
const originalArkBaseUrl = process.env.ARK_BASE_URL;
const originalArkModel = process.env.ARK_MODEL;

afterEach(() => {
  restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
  restoreEnv("OPENAI_BASE_URL", originalOpenAIBaseUrl);
  restoreEnv("OPENAI_MODEL", originalOpenAIModel);
  restoreEnv("KODEKS_MODEL_PROVIDER", originalKodeksModelProvider);
  restoreEnv("MOONBRIDGE_ENABLED", originalMoonBridgeEnabled);
  restoreEnv("MOONBRIDGE_API_KEY", originalMoonBridgeKey);
  restoreEnv("MOONBRIDGE_BASE_URL", originalMoonBridgeBaseUrl);
  restoreEnv("MOONBRIDGE_MODEL", originalMoonBridgeModel);
  restoreEnv("MOONBRIDGE_REASONING_EFFORT", originalMoonBridgeReasoningEffort);
  restoreEnv("DEEPSEEK_API_KEY", originalDeepSeekKey);
  restoreEnv("DEEPSEEK_BASE_URL", originalDeepSeekBaseUrl);
  restoreEnv("DEEPSEEK_MODEL", originalDeepSeekModel);
  restoreEnv("DEEPSEEK_REASONING_EFFORT", originalDeepSeekReasoningEffort);
  restoreEnv("ARK_API_KEY", originalArkKey);
  restoreEnv("ARK_BASE_URL", originalArkBaseUrl);
  restoreEnv("ARK_MODEL", originalArkModel);
});

// Restores a process env var without stringifying undefined into "undefined".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe("createKodeksUIMessageResponse", () => {
  it("returns a Vercel AI SDK UIMessage stream response for runtime errors", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.KODEKS_MODEL_PROVIDER;
    delete process.env.MOONBRIDGE_ENABLED;
    delete process.env.MOONBRIDGE_BASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ARK_API_KEY;

    const response = createKodeksUIMessageResponse({ input: "hello", session_id: "s1" });
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("Set KODEKS_MODEL_PROVIDER=moonbridge");
  });
});

describe("streamKodeksChat", () => {
  it("stops before starting runtime work when the client request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = new Response(streamKodeksChat({ input: "hello", session_id: "s1" }, { signal: controller.signal }));

    await expect(response.text()).resolves.toBe("");
  });
});

describe("resolveModelClientOptions", () => {
  it("prefers Moon Bridge Responses configuration when enabled", () => {
    expect(
      resolveModelClientOptions({
        MOONBRIDGE_ENABLED: "true",
        MOONBRIDGE_BASE_URL: "http://127.0.0.1:38440/v1",
        MOONBRIDGE_MODEL: "moonbridge",
        DEEPSEEK_API_KEY: "deepseek-key",
        OPENAI_API_KEY: "openai-key"
      })
    ).toEqual({
      apiKey: "moonbridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge",
      reasoningEffort: "high",
      provider: "moonbridge"
    });
  });

  it("uses Moon Bridge defaults when explicitly selected", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "moonbridge"
      })
    ).toEqual({
      apiKey: "moonbridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge",
      reasoningEffort: "high",
      provider: "moonbridge"
    });
  });

  it("prefers DeepSeek Chat Completions configuration", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.test",
        DEEPSEEK_MODEL: "deepseek-test",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_MODEL: "gpt-test"
      })
    ).toEqual({
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.test",
      model: "deepseek-test",
      reasoningEffort: "high",
      provider: "deepseek"
    });
  });

  it("defaults to DeepSeek V4 Pro with high reasoning effort", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key"
      })
    ).toEqual({
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
      provider: "deepseek"
    });
  });

  it("accepts a valid request-level reasoning effort", () => {
    expect(
      resolveModelClientOptions(
        {
          DEEPSEEK_API_KEY: "deepseek-key"
        },
        "xhigh"
      )
    ).toMatchObject({
      reasoningEffort: "xhigh"
    });
  });

  it("falls back to OpenAI Responses when DeepSeek is not configured", () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_MODEL: "gpt-test"
      })
    ).toEqual({
      apiKey: "openai-key",
      baseURL: "https://example.test/v1",
      model: "gpt-test",
      reasoningEffort: "medium",
      provider: "openai"
    });
  });

  it("returns null when no supported provider key is configured", () => {
    expect(resolveModelClientOptions({})).toBeNull();
  });
});
