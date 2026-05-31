import OpenAI from "openai";
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseInput,
  ResponseOutputText,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import type {
  ChatMessage,
  ChatToolDefinition,
  ModelClient,
  ModelTurnRequest,
  ModelTurnStreamEvent,
  ReasoningEffort,
} from "../types";
import { parseToolArguments, stringifyToolArguments } from "./common";

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
  store: false;
  reasoning?: {
    effort: ReasoningEffort;
  };
  stream: true;
};

type OpenAIResponsesApiClient = {
  responses: {
    create(
      payload: ResponsesCreatePayload,
    ): PromiseLike<AsyncIterable<unknown>> | AsyncIterable<unknown>;
  };
};

type ResponsesFunctionCallItem = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
  reasoning_content?: string | null;
};

// 把内部工具定义转换为 OpenAI Responses API 的 function tool。
export function toOpenAIResponsesTools(
  tools: ChatToolDefinition[],
): FunctionTool[] {
  return tools.map((definition) => ({
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: false,
  }));
}

export class OpenAIResponsesClient implements ModelClient {
  private readonly client: OpenAIResponsesApiClient;
  private readonly model: string;
  private readonly reasoningEffort?: ReasoningEffort;

  // 创建一个 Responses API 流式客户端，保留 OpenAI 作为可选 fallback。
  constructor(options: OpenAIResponsesClientOptions) {
    this.client =
      options.client ??
      // Narrow the SDK client to the small Responses surface this adapter uses.
      (new OpenAI({
        apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
        baseURL: options.baseURL,
      }) as unknown as OpenAIResponsesApiClient);
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
  }

  // 执行一轮 Responses API 调用，并映射为 runtime 稳定事件。
  async *streamTurn(
    request: ModelTurnRequest,
  ): AsyncIterable<ModelTurnStreamEvent> {
    const mappedInput = toOpenAIResponsesInput(request.messages);
    const payload: ResponsesCreatePayload = {
      model: this.model,
      ...mappedInput,
      tools: toOpenAIResponsesTools(request.tools),
      store: false,
      ...(this.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: this.reasoningEffort } }),
      stream: true,
    };
    const stream = await this.client.responses.create(payload);
    let sawToolCall = false;

    for await (const chunk of stream) {
      const event = chunk as ResponseStreamEvent;
      if (event.type === "response.output_text.delta") {
        yield { type: "text_delta", text: event.delta };
        continue;
      }

      if (
        event.type === "response.output_item.done" &&
        event.item.type === "function_call"
      ) {
        const item = event.item as ResponsesFunctionCallItem;
        sawToolCall = true;
        yield {
          type: "tool_call" as const,
          id: item.call_id,
          name: item.name,
          args: parseToolArguments(item.arguments),
          ...(typeof item.reasoning_content === "string" &&
          item.reasoning_content.length > 0
            ? { reasoningContent: item.reasoning_content }
            : {}),
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
        yield {
          type: "error",
          message: event.response.error?.message ?? "Response failed.",
        };
      }
    }
  }
}

// 把内部 transcript 转换为 Responses API 的 instructions 和 input items。
export function toOpenAIResponsesInput(messages: ChatMessage[]): {
  instructions?: string;
  input: ResponseInput;
} {
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
        output: message.content,
      });
      continue;
    }

    if (
      message.role === "assistant" &&
      message.toolCalls !== undefined &&
      message.toolCalls.length > 0
    ) {
      if (message.content.trim().length > 0) {
        input.push(toResponsesMessage(message));
      }
      for (const toolCall of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: stringifyToolArguments(toolCall.args),
          ...(message.reasoningContent === undefined
            ? {}
            : { reasoning_content: message.reasoningContent }),
        });
      }
      continue;
    }

    input.push(toResponsesMessage(message));
  }

  return instructions.length > 0 ? { instructions, input } : { input };
}

// 把纯文本 user/assistant 消息转换为 Responses API message item。
function toResponsesMessage(message: ChatMessage): EasyInputMessage {
  if (message.role === "assistant") {
    const assistantMessage = {
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: [],
        } satisfies ResponseOutputText,
      ],
    };
    // The SDK response input union does not expose this assistant item shape directly.
    return assistantMessage as unknown as EasyInputMessage;
  }

  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.content }],
  };
}
