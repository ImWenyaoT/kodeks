import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  name?: string;
};

export type ChatToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelTurnRequest = {
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
};

export type ModelTurnStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "response_completed"; responseId: string }
  | { type: "error"; message: string };

export interface ModelClient {
  streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent>;
}

export type OpenAIChatCompletionsClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
};

// Converts internal tool definitions to OpenAI Chat Completions function tools.
export function toOpenAIChatTools(tools: ChatToolDefinition[]): Array<{
  type: "function";
  function: ChatToolDefinition;
}> {
  return tools.map((definition) => ({
    type: "function",
    function: definition
  }));
}

export class OpenAIChatCompletionsClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;

  // Creates an OpenAI-compatible Chat Completions streaming client.
  constructor(options: OpenAIChatCompletionsClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseURL
    });
    this.model = options.model;
  }

  // Streams one model turn and maps deltas into the runtime event contract.
  async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: request.messages.map(toOpenAIChatMessage),
      tools: toOpenAIChatTools(request.tools),
      stream: true
    });

    const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>();
    let responseId = "";

    for await (const chunk of stream) {
      responseId = chunk.id || responseId;
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content !== undefined && delta.content !== null) {
        yield { type: "text_delta", text: delta.content };
      }
      for (const toolCall of delta?.tool_calls ?? []) {
        const index = toolCall.index;
        const current = toolCalls.get(index) ?? { id: "", name: "", argumentsText: "" };
        current.id = toolCall.id ?? current.id;
        current.name = toolCall.function?.name ?? current.name;
        current.argumentsText += toolCall.function?.arguments ?? "";
        toolCalls.set(index, current);
      }
      if (choice?.finish_reason === "tool_calls") {
        for (const toolCall of toolCalls.values()) {
          yield {
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            args: parseToolArguments(toolCall.argumentsText)
          };
        }
        toolCalls.clear();
      }
      if (choice?.finish_reason === "stop") {
        yield { type: "response_completed", responseId };
      }
    }
  }
}

// Converts internal messages to OpenAI's role-specific chat message union.
function toOpenAIChatMessage(message: ChatMessage): ChatCompletionMessageParam {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? ""
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content
    };
  }
  if (message.role === "system") {
    return {
      role: "system",
      content: message.content
    };
  }
  return {
    role: "user",
    content: message.content
  };
}

// Parses streamed tool arguments while returning a readable fallback on malformed JSON.
function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
