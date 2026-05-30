import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadConfiguredModelCatalog,
  loadModelRuntimeEnv,
  OpenAIResponsesClient,
  resolveModelClientOptions,
  resolveKodeksConfigDir,
  resolveKodeksConfigPath,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
  type ChatToolDefinition,
} from "./index";
import {
  DeepSeekChatCompletionsClient,
  toDeepSeekChatMessages,
  toDeepSeekChatTools,
  toDeepSeekThinkingOptions,
} from "./providers/deepseek-chat";

describe("toOpenAIResponsesTools", () => {
  it("maps internal tool definitions to Responses API function tools", () => {
    const tools: ChatToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];

    expect(toOpenAIResponsesTools(tools)).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
        strict: false,
      },
    ]);
  });
});

describe("toOpenAIResponsesInput", () => {
  it("maps previous assistant text as Responses API output text", () => {
    expect(
      toOpenAIResponsesInput([
        { role: "user", content: "hi" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
        { role: "user", content: "继续" },
      ]),
    ).toEqual({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "你好，有什么可以帮你？",
              annotations: [],
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "继续" }],
        },
      ],
    });
  });

  it("maps assistant tool calls and tool outputs to Responses API items", () => {
    expect(
      toOpenAIResponsesInput([
        { role: "system", content: "You are Kodeks." },
        { role: "user", content: "read README" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              args: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: "project docs",
          toolCallId: "call_1",
          name: "read_file",
        },
      ]),
    ).toEqual({
      instructions: "You are Kodeks.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "read README" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "project docs",
        },
      ],
    });
  });
});

describe("OpenAIResponsesClient", () => {
  it("streams Responses API text and final completion into model events", async () => {
    const calls: unknown[] = [];
    const client = new OpenAIResponsesClient({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      model: "gpt-test",
      client: {
        responses: {
          create: async (payload: unknown) => {
            calls.push(payload);
            return streamEvents([
              { type: "response.output_text.delta", delta: "Hello" },
              { type: "response.completed", response: { id: "resp_1" } },
            ]);
          },
        },
      },
    });

    const events = await collectEvents(
      client.streamTurn({
        messages: [
          { role: "system", content: "You are Kodeks." },
          { role: "user", content: "read README" },
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        ],
      }),
    );

    expect(calls).toEqual([
      {
        model: "gpt-test",
        instructions: "You are Kodeks.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "read README" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
            strict: false,
          },
        ],
        stream: true,
      },
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "response_completed", responseId: "resp_1" },
    ]);
  });

  it("passes configured reasoning effort to the Responses API", async () => {
    const calls: unknown[] = [];
    const client = new OpenAIResponsesClient({
      apiKey: "test-key",
      model: "gpt-test",
      reasoningEffort: "medium",
      client: {
        responses: {
          create: async (payload: unknown) => {
            calls.push(payload);
            return streamEvents([
              {
                type: "response.completed",
                response: { id: "resp_reasoning" },
              },
            ]);
          },
        },
      },
    });

    await collectEvents(
      client.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    );

    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      reasoning: { effort: "medium" },
    });
  });

  it("does not mark a function-call response as final before tool outputs are sent", async () => {
    const client = new OpenAIResponsesClient({
      apiKey: "test-key",
      model: "gpt-test",
      client: {
        responses: {
          create: async () =>
            streamEvents([
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "call_1",
                  name: "read_file",
                  arguments: JSON.stringify({ path: "README.md" }),
                },
              },
              { type: "response.completed", response: { id: "resp_tool" } },
            ]),
        },
      },
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: [],
        }),
      ),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "read_file",
        args: { path: "README.md" },
      },
    ]);
  });
});

describe("toDeepSeekChatTools", () => {
  it("maps internal tool definitions to Chat Completions function tools", () => {
    const tools: ChatToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];

    expect(toDeepSeekChatTools(tools)).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ]);
  });
});

describe("toDeepSeekChatMessages", () => {
  it("maps assistant tool calls and tool outputs to Chat Completions messages", () => {
    expect(
      toDeepSeekChatMessages([
        { role: "system", content: "You are Kodeks." },
        { role: "user", content: "read README" },
        {
          role: "assistant",
          content: "",
          reasoningContent: "Need to inspect the README first.",
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              args: { path: "README.md" },
            },
          ],
        },
        {
          role: "tool",
          content: "project docs",
          toolCallId: "call_1",
          name: "read_file",
        },
      ]),
    ).toEqual([
      { role: "system", content: "You are Kodeks." },
      { role: "user", content: "read README" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "Need to inspect the README first.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          },
        ],
      },
      {
        role: "tool",
        content: "project docs",
        tool_call_id: "call_1",
        name: "read_file",
      },
    ]);
  });
});

describe("toDeepSeekThinkingOptions", () => {
  it("disables thinking when reasoning effort is none", () => {
    expect(toDeepSeekThinkingOptions("none")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("maps xhigh to DeepSeek max thinking", () => {
    expect(toDeepSeekThinkingOptions("xhigh")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });
});

describe("DeepSeekChatCompletionsClient", () => {
  it("streams Chat Completions text without exposing reasoning content", async () => {
    const calls: unknown[] = [];
    const client = new DeepSeekChatCompletionsClient({
      apiKey: "test-key",
      baseURL: "https://api.deepseek.test",
      model: "deepseek-v4-pro",
      client: {
        chat: {
          completions: {
            create: async (payload: unknown) => {
              calls.push(payload);
              return streamEvents([
                {
                  id: "chatcmpl_1",
                  choices: [
                    {
                      delta: { reasoning_content: "private chain" },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chatcmpl_1",
                  choices: [
                    { delta: { content: "你好" }, finish_reason: null },
                  ],
                },
                {
                  id: "chatcmpl_1",
                  choices: [{ delta: {}, finish_reason: "stop" }],
                },
              ]);
            },
          },
        },
      },
    });

    const events = await collectEvents(
      client.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    );

    expect(calls[0]).toMatchObject({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: true,
    });
    expect(events).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "response_completed", responseId: "chatcmpl_1" },
    ]);
  });

  it("merges streamed tool call chunks and preserves reasoning for continuation", async () => {
    const client = new DeepSeekChatCompletionsClient({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      client: {
        chat: {
          completions: {
            create: async () =>
              streamEvents([
                {
                  id: "chatcmpl_tool",
                  choices: [
                    {
                      delta: {
                        reasoning_content: "Need the file.",
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_1",
                            type: "function",
                            function: {
                              name: "read_file",
                              arguments: '{"path"',
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "chatcmpl_tool",
                  choices: [
                    {
                      delta: {
                        reasoning_content: " Then summarize.",
                        tool_calls: [
                          {
                            index: 0,
                            function: { arguments: ':"README.md"}' },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                },
              ]),
          },
        },
      },
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: [],
        }),
      ),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "read_file",
        args: { path: "README.md" },
        reasoningContent: "Need the file. Then summarize.",
      },
    ]);
  });

  it("returns empty tool args when streamed arguments are malformed", async () => {
    const client = new DeepSeekChatCompletionsClient({
      apiKey: "test-key",
      model: "deepseek-v4-pro",
      client: {
        chat: {
          completions: {
            create: async () =>
              streamEvents([
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_bad",
                            function: {
                              name: "read_file",
                              arguments: "not-json",
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                },
              ]),
          },
        },
      },
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: [],
        }),
      ),
    ).resolves.toEqual([
      { type: "tool_call", id: "call_bad", name: "read_file", args: {} },
    ]);
  });
});

describe("resolveModelClientOptions", () => {
  it("resolves direct Responses-compatible endpoint configuration", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "responses",
        KODEKS_RESPONSES_API_KEY: "responses-key",
        KODEKS_RESPONSES_BASE_URL: "https://responses-compatible.test/v1",
        KODEKS_RESPONSES_MODEL: "responses-model",
        KODEKS_RESPONSES_REASONING_EFFORT: "low",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "responses-key",
      baseURL: "https://responses-compatible.test/v1",
      model: "responses-model",
      reasoningEffort: "low",
    });
  });

  it("uses a placeholder key for local Responses-compatible endpoints", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "responses",
        KODEKS_RESPONSES_BASE_URL: "http://127.0.0.1:9999/v1",
        KODEKS_RESPONSES_MODEL: "local-responses",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "not-needed",
      baseURL: "http://127.0.0.1:9999/v1",
      model: "local-responses",
      reasoningEffort: "medium",
    });
  });

  it("routes generic Chat Completions endpoint configuration through MoonBridge", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_CHAT_COMPLETIONS_API_KEY: "chat-key",
        KODEKS_CHAT_COMPLETIONS_BASE_URL: "https://qwen.test/v1",
        KODEKS_CHAT_COMPLETIONS_MODEL: "qwen-coder",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
    });
  });

  it("prefers built-in bridge Responses when configured", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_BRIDGE_ENABLED: "true",
        KODEKS_BRIDGE_BASE_URL: "http://127.0.0.1:38440/v1/",
        KODEKS_BRIDGE_MODEL: "bridge",
        DEEPSEEK_API_KEY: "deepseek-key",
        OPENAI_API_KEY: "openai-key",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
    });
  });

  it("maps legacy bridge selection to MoonBridge defaults", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "bridge",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
    });
  });

  it("keeps Moon Bridge environment names as compatibility aliases", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "moonbridge",
        MOONBRIDGE_API_KEY: "moonbridge-key",
        MOONBRIDGE_BASE_URL: "http://127.0.0.1:38440/v1",
        MOONBRIDGE_MODEL: "moonbridge",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "moonbridge-key",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge",
      reasoningEffort: "high",
    });
  });

  it("maps legacy DeepSeek provider selection to MoonBridge", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "deepseek",
        KODEKS_BRIDGE_BASE_URL: "http://127.0.0.1:38440/v1",
        DEEPSEEK_API_KEY: "deepseek-key",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
    });
  });

  it("uses request-level MoonBridge override before configured OpenAI", () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
          MOONBRIDGE_MODEL: "moonbridge-session",
        },
        undefined,
        "moonbridge",
      ),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge-session",
      reasoningEffort: "high",
    });
  });

  it("maps request-level bridge override to MoonBridge before configured OpenAI", () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
          KODEKS_BRIDGE_MODEL: "bridge-session",
        },
        undefined,
        "bridge",
      ),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge-session",
      reasoningEffort: "high",
    });
  });

  it("uses request-level OpenAI override before configured bridge", () => {
    expect(
      resolveModelClientOptions(
        {
          KODEKS_BRIDGE_ENABLED: "true",
          OPENAI_API_KEY: "openai-key",
        },
        undefined,
        "openai",
      ),
    ).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
  });

  it("maps request-level DeepSeek override to MoonBridge", () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
          DEEPSEEK_API_KEY: "deepseek-key",
        },
        undefined,
        "deepseek",
      ),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
    });
  });

  it("prefers OpenAI Responses over DeepSeek fallback when both keys are configured", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.test",
        DEEPSEEK_MODEL: "deepseek-test",
        OPENAI_API_KEY: "openai-key",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
  });

  it("maps legacy DeepSeek-only env to MoonBridge as Chat Completions upstream", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_REASONING_EFFORT: "xhigh",
      }),
    ).toEqual({
      provider: "moonbridge",
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "xhigh",
    });
  });

  it("falls back to OpenAI Responses when DeepSeek is not configured", () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: "openai-key",
      }),
    ).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
    });
  });
});

describe("loadModelRuntimeEnv", () => {
  it("loads user config from a repo-external JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          provider: "responses",
          responses: {
            apiKey: "config-key",
            baseURL: "https://responses-config.test/v1",
            model: "config-model",
            reasoningEffort: "high",
          },
          chatCompletions: {
            apiKey: "chat-config-key",
            baseURL: "https://chat-config.test/v1",
            model: "chat-config-model",
          },
        },
      }),
    );

    try {
      expect(loadModelRuntimeEnv({ KODEKS_CONFIG_PATH: configPath })).toEqual(
        expect.objectContaining({
          KODEKS_CONFIG_PATH: configPath,
          KODEKS_MODEL_PROVIDER: "openai",
          KODEKS_RESPONSES_API_KEY: "config-key",
          KODEKS_RESPONSES_BASE_URL: "https://responses-config.test/v1",
          KODEKS_RESPONSES_MODEL: "config-model",
          KODEKS_RESPONSES_REASONING_EFFORT: "high",
          KODEKS_CHAT_COMPLETIONS_API_KEY: "chat-config-key",
          KODEKS_CHAT_COMPLETIONS_BASE_URL: "https://chat-config.test/v1",
          KODEKS_CHAT_COMPLETIONS_MODEL: "chat-config-model",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads OpenClaw-style provider registry and embeddings config", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          primary: "qwen/qwen3.6",
          providers: {
            qwen: {
              api: "chat-completions",
              baseURL: "http://172.18.45.70:8010/v1",
              apiKey: "${QWEN_API_KEY}",
              models: [{ id: "qwen3.6", name: "Qwen 3.6" }],
            },
          },
        },
        embeddings: {
          enabled: true,
          provider: "openai-compatible",
          baseURL: "http://172.18.45.70:8011/v1",
          apiKey: "local-placeholder",
          model: "qwen3-embedding-4b",
        },
      }),
    );

    try {
      expect(
        loadModelRuntimeEnv({
          KODEKS_CONFIG_PATH: configPath,
          QWEN_API_KEY: "qwen-key",
        }),
      ).toEqual(
        expect.objectContaining({
          KODEKS_MODEL_PROVIDER: "moonbridge",
          KODEKS_CHAT_COMPLETIONS_API_KEY: "qwen-key",
          KODEKS_CHAT_COMPLETIONS_BASE_URL: "http://172.18.45.70:8010/v1",
          KODEKS_CHAT_COMPLETIONS_MODEL: "qwen3.6",
          KODEKS_EMBEDDINGS_ENABLED: "true",
          KODEKS_EMBEDDINGS_PROVIDER: "openai-compatible",
          KODEKS_OPENAI_COMPAT_BASE_URL: "http://172.18.45.70:8011/v1",
          KODEKS_OPENAI_COMPAT_API_KEY: "local-placeholder",
          KODEKS_OPENAI_COMPAT_EMBED_MODEL: "qwen3-embedding-4b",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can select a non-primary configured provider/model ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          primary: "qwen/qwen3.6",
          providers: {
            qwen: {
              api: "chat-completions",
              baseURL: "http://qwen.test/v1",
              apiKey: "qwen-key",
              models: [{ id: "qwen3.6", name: "Qwen 3.6" }],
            },
            openai: {
              api: "responses",
              baseURL: "https://responses.test/v1",
              apiKey: "responses-key",
              models: [{ id: "gpt-5.4-mini", name: "GPT 5.4 mini" }],
            },
          },
        },
      }),
    );

    try {
      expect(
        loadModelRuntimeEnv(
          {
            KODEKS_CONFIG_PATH: configPath,
          },
          "openai/gpt-5.4-mini",
        ),
      ).toEqual(
        expect.objectContaining({
          KODEKS_MODEL_PROVIDER: "openai",
          KODEKS_RESPONSES_API_KEY: "responses-key",
          KODEKS_RESPONSES_BASE_URL: "https://responses.test/v1",
          KODEKS_RESPONSES_MODEL: "gpt-5.4-mini",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists configured models without exposing provider secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          primary: "qwen/qwen3.6",
          providers: {
            qwen: {
              api: "chat-completions",
              baseURL: "http://qwen.test/v1",
              apiKey: "secret-qwen-key",
              models: [{ id: "qwen3.6", name: "Qwen 3.6" }],
            },
            openai: {
              api: "responses",
              apiKey: "secret-openai-key",
              models: [{ id: "gpt-5.4-mini", name: "GPT 5.4 mini" }],
            },
          },
        },
      }),
    );

    try {
      expect(
        loadConfiguredModelCatalog({ KODEKS_CONFIG_PATH: configPath }),
      ).toEqual({
        primary: "qwen/qwen3.6",
        models: [
          {
            ref: "qwen/qwen3.6",
            providerId: "qwen",
            providerName: "qwen",
            modelId: "qwen3.6",
            modelName: "Qwen 3.6",
            api: "chat-completions",
            requiresBridge: true,
            baseURL: "http://qwen.test/v1",
            configured: true,
          },
          {
            ref: "openai/gpt-5.4-mini",
            providerId: "openai",
            providerName: "openai",
            modelId: "gpt-5.4-mini",
            modelName: "GPT 5.4 mini",
            api: "responses",
            requiresBridge: false,
            configured: true,
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks remote Chat Completions models without an api key as unconfigured", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          primary: "qwen/qwen3.6",
          providers: {
            qwen: {
              api: "chat-completions",
              baseURL: "https://qwen.example/v1",
              models: [{ id: "qwen3.6", name: "Qwen 3.6" }],
            },
            local: {
              api: "chat-completions",
              baseURL: "http://127.0.0.1:8010/v1",
              models: [{ id: "local-qwen", name: "Local Qwen" }],
            },
          },
        },
      }),
    );

    try {
      expect(
        loadConfiguredModelCatalog({ KODEKS_CONFIG_PATH: configPath }).models,
      ).toEqual([
        expect.objectContaining({
          ref: "qwen/qwen3.6",
          configured: false,
        }),
        expect.objectContaining({
          ref: "local/local-qwen",
          configured: true,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets explicit environment values override user config values", () => {
    const dir = mkdtempSync(join(tmpdir(), "kodeks-model-config-"));
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          provider: "responses",
          responses: { apiKey: "config-key" },
        },
      }),
    );

    try {
      expect(
        loadModelRuntimeEnv({
          KODEKS_CONFIG_PATH: configPath,
          KODEKS_RESPONSES_API_KEY: "env-key",
        }).KODEKS_RESPONSES_API_KEY,
      ).toBe("env-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves an explicit config path", () => {
    expect(
      resolveKodeksConfigPath({ KODEKS_CONFIG_PATH: "./kodeks.json" }),
    ).toBe(join(process.cwd(), "kodeks.json"));
  });

  it("resolves config dir overrides before legacy platform paths", () => {
    expect(
      resolveKodeksConfigDir({ KODEKS_CONFIG_DIR: "./.kodeks-test" }),
    ).toBe(join(process.cwd(), ".kodeks-test"));
    expect(
      resolveKodeksConfigPath({ KODEKS_CONFIG_DIR: "./.kodeks-test" }),
    ).toBe(join(process.cwd(), ".kodeks-test", "config.json"));
  });
});

async function* streamEvents(events: unknown[]): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
