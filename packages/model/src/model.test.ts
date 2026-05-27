import { describe, expect, it } from "vitest";

import {
  DeepSeekChatCompletionsClient,
  OpenAIResponsesClient,
  resolveModelClientOptions,
  toDeepSeekChatMessages,
  toDeepSeekChatTools,
  toDeepSeekThinkingOptions,
  toOpenAIResponsesInput,
  toOpenAIResponsesTools,
  type ChatToolDefinition
} from "./index";

describe("toOpenAIResponsesTools", () => {
  it("maps internal tool definitions to Responses API function tools", () => {
    const tools: ChatToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    ];

    expect(toOpenAIResponsesTools(tools)).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        },
        strict: false
      }
    ]);
  });
});

describe("toOpenAIResponsesInput", () => {
  it("maps previous assistant text as Responses API output text", () => {
    expect(
      toOpenAIResponsesInput([
        { role: "user", content: "hi" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
        { role: "user", content: "继续" }
      ])
    ).toEqual({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }]
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "你好，有什么可以帮你？", annotations: [] }]
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "继续" }]
        }
      ]
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
              args: { path: "README.md" }
            }
          ]
        },
        { role: "tool", content: "project docs", toolCallId: "call_1", name: "read_file" }
      ])
    ).toEqual({
      instructions: "You are Kodeks.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "read README" }]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" })
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "project docs"
        }
      ]
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
              { type: "response.completed", response: { id: "resp_1" } }
            ]);
          }
        }
      }
    });

    const events = await collectEvents(
      client.streamTurn({
        messages: [
          { role: "system", content: "You are Kodeks." },
          { role: "user", content: "read README" }
        ],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } }
          }
        ]
      })
    );

    expect(calls).toEqual([
      {
        model: "gpt-test",
        instructions: "You are Kodeks.",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "read README" }]
          }
        ],
        tools: [
          {
            type: "function",
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
            strict: false
          }
        ],
        stream: true
      }
    ]);
    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "response_completed", responseId: "resp_1" }
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
            return streamEvents([{ type: "response.completed", response: { id: "resp_reasoning" } }]);
          }
        }
      }
    });

    await collectEvents(
      client.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        tools: []
      })
    );

    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      reasoning: { effort: "medium" }
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
                  arguments: JSON.stringify({ path: "README.md" })
                }
              },
              { type: "response.completed", response: { id: "resp_tool" } }
            ])
        }
      }
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: []
        })
      )
    ).resolves.toEqual([{ type: "tool_call", id: "call_1", name: "read_file", args: { path: "README.md" } }]);
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
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
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
              path: { type: "string" }
            },
            required: ["path"]
          }
        }
      }
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
              args: { path: "README.md" }
            }
          ]
        },
        { role: "tool", content: "project docs", toolCallId: "call_1", name: "read_file" }
      ])
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
              arguments: JSON.stringify({ path: "README.md" })
            }
          }
        ]
      },
      { role: "tool", content: "project docs", tool_call_id: "call_1", name: "read_file" }
    ]);
  });
});

describe("toDeepSeekThinkingOptions", () => {
  it("disables thinking when reasoning effort is none", () => {
    expect(toDeepSeekThinkingOptions("none")).toEqual({
      thinking: { type: "disabled" }
    });
  });

  it("maps xhigh to DeepSeek max thinking", () => {
    expect(toDeepSeekThinkingOptions("xhigh")).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
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
                  choices: [{ delta: { reasoning_content: "private chain" }, finish_reason: null }]
                },
                {
                  id: "chatcmpl_1",
                  choices: [{ delta: { content: "你好" }, finish_reason: null }]
                },
                {
                  id: "chatcmpl_1",
                  choices: [{ delta: {}, finish_reason: "stop" }]
                }
              ]);
            }
          }
        }
      }
    });

    const events = await collectEvents(
      client.streamTurn({
        messages: [{ role: "user", content: "hello" }],
        tools: []
      })
    );

    expect(calls[0]).toMatchObject({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      stream: true
    });
    expect(events).toEqual([
      { type: "text_delta", text: "你好" },
      { type: "response_completed", responseId: "chatcmpl_1" }
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
                            function: { name: "read_file", arguments: "{\"path\"" }
                          }
                        ]
                      },
                      finish_reason: null
                    }
                  ]
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
                            function: { arguments: ":\"README.md\"}" }
                          }
                        ]
                      },
                      finish_reason: "tool_calls"
                    }
                  ]
                }
              ])
          }
        }
      }
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: []
        })
      )
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "call_1",
        name: "read_file",
        args: { path: "README.md" },
        reasoningContent: "Need the file. Then summarize."
      }
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
                            function: { name: "read_file", arguments: "not-json" }
                          }
                        ]
                      },
                      finish_reason: "tool_calls"
                    }
                  ]
                }
              ])
          }
        }
      }
    });

    await expect(
      collectEvents(
        client.streamTurn({
          messages: [{ role: "user", content: "read README" }],
          tools: []
        })
      )
    ).resolves.toEqual([{ type: "tool_call", id: "call_bad", name: "read_file", args: {} }]);
  });
});

describe("resolveModelClientOptions", () => {
  it("prefers Moon Bridge Responses when configured", () => {
    expect(
      resolveModelClientOptions({
        MOONBRIDGE_ENABLED: "true",
        MOONBRIDGE_BASE_URL: "http://127.0.0.1:38440/v1",
        MOONBRIDGE_MODEL: "moonbridge",
        DEEPSEEK_API_KEY: "deepseek-key",
        OPENAI_API_KEY: "openai-key"
      })
    ).toEqual({
      provider: "moonbridge",
      apiKey: "moonbridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge",
      reasoningEffort: "high"
    });
  });

  it("uses Moon Bridge defaults when selected explicitly", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "moonbridge"
      })
    ).toEqual({
      provider: "moonbridge",
      apiKey: "moonbridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge",
      reasoningEffort: "high"
    });
  });

  it("can force DeepSeek direct mode even when Moon Bridge env exists", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "deepseek",
        MOONBRIDGE_BASE_URL: "http://127.0.0.1:38440/v1",
        DEEPSEEK_API_KEY: "deepseek-key"
      })
    ).toEqual({
      provider: "deepseek",
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      reasoningEffort: "high"
    });
  });

  it("prefers DeepSeek over OpenAI when both keys are configured", () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_BASE_URL: "https://api.deepseek.test",
        DEEPSEEK_MODEL: "deepseek-test",
        OPENAI_API_KEY: "openai-key"
      })
    ).toEqual({
      provider: "deepseek",
      apiKey: "deepseek-key",
      baseURL: "https://api.deepseek.test",
      model: "deepseek-test",
      reasoningEffort: "high"
    });
  });

  it("falls back to OpenAI Responses when DeepSeek is not configured", () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: "openai-key"
      })
    ).toEqual({
      provider: "openai",
      apiKey: "openai-key",
      baseURL: undefined,
      model: "gpt-5.4-mini",
      reasoningEffort: "medium"
    });
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
