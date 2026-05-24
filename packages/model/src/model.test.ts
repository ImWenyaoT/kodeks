import { describe, expect, it } from "vitest";

import {
  OpenAIResponsesClient,
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
