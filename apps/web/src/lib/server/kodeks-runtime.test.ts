import { afterEach, describe, expect, it } from "vitest";

import { createKodeksUIMessageResponse, resolveModelClientOptions } from "./kodeks-runtime";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAIModel = process.env.OPENAI_MODEL;
const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const originalDeepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const originalDeepSeekModel = process.env.DEEPSEEK_MODEL;
const originalArkKey = process.env.ARK_API_KEY;
const originalArkBaseUrl = process.env.ARK_BASE_URL;
const originalArkModel = process.env.ARK_MODEL;

afterEach(() => {
  restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
  restoreEnv("OPENAI_BASE_URL", originalOpenAIBaseUrl);
  restoreEnv("OPENAI_MODEL", originalOpenAIModel);
  restoreEnv("DEEPSEEK_API_KEY", originalDeepSeekKey);
  restoreEnv("DEEPSEEK_BASE_URL", originalDeepSeekBaseUrl);
  restoreEnv("DEEPSEEK_MODEL", originalDeepSeekModel);
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
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ARK_API_KEY;

    const response = createKodeksUIMessageResponse({ input: "hello", session_id: "s1" });
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("An OpenAI API key is required for the Responses API client");
  });
});

describe("resolveModelClientOptions", () => {
  it("prefers explicit OpenAI Responses configuration", () => {
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

  it("defaults to GPT-5.4 mini with medium reasoning effort", () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: "openai-key"
      })
    ).toEqual({
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      provider: "openai"
    });
  });

  it("accepts a valid request-level reasoning effort", () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key"
        },
        "xhigh"
      )
    ).toMatchObject({
      reasoningEffort: "xhigh"
    });
  });

  it("does not resolve legacy Chat Completions-compatible provider keys for the Responses API client", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.test",
        DEEPSEEK_MODEL: "deepseek-reasoner"
      })
    ).toBeNull();
  });

  it("returns null when no supported provider key is configured", () => {
    expect(resolveModelClientOptions({})).toBeNull();
  });
});
