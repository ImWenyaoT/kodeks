import { describe, expect, it } from "vitest";

import { toOpenAIChatTools, type ChatToolDefinition } from "./index";

describe("toOpenAIChatTools", () => {
  it("maps internal tool definitions to chat-completions function tools", () => {
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

    expect(toOpenAIChatTools(tools)).toEqual([
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
