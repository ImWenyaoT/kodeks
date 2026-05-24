import OpenAI from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseInput,
  ResponseOutputText,
  ResponseStreamEvent
} from "openai/resources/responses/responses";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
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

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface ModelClient {
  streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent>;
}

export type OpenAIResponsesClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  client?: OpenAIResponsesApiClient;
};

type ResponsesCreatePayload = {
  model: string;
  instructions?: string;
  input: ResponseInput;
  tools: FunctionTool[];
  reasoning?: {
    effort: ReasoningEffort;
  };
  stream: true;
};

type OpenAIResponsesApiClient = {
  responses: {
    create(payload: ResponsesCreatePayload): PromiseLike<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
};

// Converts internal tool definitions to OpenAI Responses API function tools.
export function toOpenAIResponsesTools(tools: ChatToolDefinition[]): FunctionTool[] {
  return tools.map((definition) => ({
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: false
  }));
}

export class OpenAIResponsesClient implements ModelClient {
  private readonly client: OpenAIResponsesApiClient;
  private readonly model: string;
  private readonly reasoningEffort?: ReasoningEffort;

  // Creates a Responses API streaming client.
  constructor(options: OpenAIResponsesClientOptions) {
    this.client = options.client ?? new OpenAI({
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: options.baseURL
    });
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
  }

  // Streams one model turn and maps deltas into the runtime event contract.
  async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent> {
    const mappedInput = toOpenAIResponsesInput(request.messages);
    const payload: ResponsesCreatePayload = {
      model: this.model,
      ...mappedInput,
      tools: toOpenAIResponsesTools(request.tools),
      ...(this.reasoningEffort === undefined ? {} : { reasoning: { effort: this.reasoningEffort } }),
      stream: true
    };
    const stream = await this.client.responses.create(payload);
    let sawToolCall = false;

    for await (const chunk of stream) {
      const event = chunk as ResponseStreamEvent;
      if (event.type === "response.output_text.delta") {
        yield { type: "text_delta", text: event.delta };
        continue;
      }

      if (event.type === "response.output_item.done" && event.item.type === "function_call") {
        sawToolCall = true;
        yield {
          type: "tool_call",
          id: event.item.call_id,
          name: event.item.name,
          args: parseToolArguments(event.item.arguments)
        };
        continue;
      }

      if (event.type === "response.completed") {
        if (!sawToolCall) {
          yield { type: "response_completed", responseId: event.response.id };
        }
        continue;
      }

      if (event.type === "error") {
        yield { type: "error", message: event.message };
        continue;
      }

      if (event.type === "response.failed") {
        yield { type: "error", message: event.response.error?.message ?? "Response failed." };
      }
    }
  }
}

// Converts internal transcript messages to Responses API instructions and input items.
export function toOpenAIResponsesInput(messages: ChatMessage[]): { instructions?: string; input: ResponseInput } {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const input: ResponseInput = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "",
        output: message.content
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      if (message.content.trim().length > 0) {
        input.push(toResponsesMessage(message));
      }
      for (const toolCall of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.args)
        });
      }
      continue;
    }

    input.push(toResponsesMessage(message));
  }

  return instructions.length > 0 ? { instructions, input } : { input };
}

// Converts a text-only user or assistant message into a Responses API message item.
function toResponsesMessage(message: ChatMessage): EasyInputMessage {
  if (message.role === "assistant") {
    const assistantMessage = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] } satisfies ResponseOutputText]
    };
    return assistantMessage as unknown as EasyInputMessage;
  }

  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.content }]
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
