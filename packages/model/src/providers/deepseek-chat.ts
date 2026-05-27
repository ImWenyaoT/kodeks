import OpenAI from "openai";

import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ModelClient,
  ModelTurnRequest,
  ModelTurnStreamEvent,
  ReasoningEffort
} from "../types";
import { parseToolArguments, stringifyToolArguments } from "./common";

export type DeepSeekThinkingOptions = {
  thinking: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "high" | "max";
};

export type DeepSeekChatCompletionsClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  client?: DeepSeekChatCompletionsApiClient;
};

export type DeepSeekChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekChatToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type DeepSeekChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type DeepSeekChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type DeepSeekChatCompletionsPayload = DeepSeekThinkingOptions & {
  model: string;
  messages: DeepSeekChatMessage[];
  tools: DeepSeekChatTool[];
  stream: true;
};

type DeepSeekChatCompletionsApiClient = {
  chat: {
    completions: {
      create(
        payload: DeepSeekChatCompletionsPayload
      ): PromiseLike<AsyncIterable<unknown>> | AsyncIterable<unknown>;
    };
  };
};

type DeepSeekStreamChunk = {
  id?: string;
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
};

type DeepSeekToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type PendingToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export class DeepSeekChatCompletionsClient implements ModelClient {
  private readonly client: DeepSeekChatCompletionsApiClient;
  private readonly model: string;
  private readonly reasoningEffort: ReasoningEffort;

  // 创建 DeepSeek Chat Completions 客户端；DeepSeek 目前兼容 OpenAI chat.completions。
  constructor(options: DeepSeekChatCompletionsClientOptions) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY,
        baseURL: options.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL
      }) as unknown as DeepSeekChatCompletionsApiClient);
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort ?? "high";
  }

  // 执行一轮 DeepSeek Chat Completions 调用，并隐藏 reasoning_content 的 UI 输出。
  async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent> {
    const payload: DeepSeekChatCompletionsPayload = {
      model: this.model,
      messages: toDeepSeekChatMessages(request.messages),
      tools: toDeepSeekChatTools(request.tools),
      ...toDeepSeekThinkingOptions(this.reasoningEffort),
      stream: true
    };
    const stream = await this.client.chat.completions.create(payload);
    const pendingToolCalls = new Map<number, PendingToolCall>();
    let reasoningContent = "";
    let completionId = "";

    for await (const rawChunk of stream) {
      const chunk = rawChunk as DeepSeekStreamChunk;
      if (chunk.error?.message !== undefined) {
        yield { type: "error", message: chunk.error.message };
        continue;
      }

      completionId = chunk.id ?? completionId;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content !== undefined && delta.reasoning_content !== null) {
        reasoningContent += delta.reasoning_content;
      }

      if (delta?.content !== undefined && delta.content !== null && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      }

      for (const chunkToolCall of delta?.tool_calls ?? []) {
        mergeToolCallChunk(pendingToolCalls, chunkToolCall);
      }

      if (choice?.finish_reason === "tool_calls") {
        for (const toolCall of pendingToolCalls.values()) {
          yield {
            type: "tool_call",
            id: toolCall.id,
            name: toolCall.name,
            args: parseToolArguments(toolCall.argumentsText),
            reasoningContent: reasoningContent.length > 0 ? reasoningContent : undefined
          };
        }
        continue;
      }

      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        yield { type: "response_completed", responseId: completionId || "deepseek_chat_completion" };
      }
    }
  }
}

// 把内部工具定义转换为 Chat Completions 的 function tools。
export function toDeepSeekChatTools(tools: ChatToolDefinition[]): DeepSeekChatTool[] {
  return tools.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters
    }
  }));
}

// 把内部消息转换为 DeepSeek/OpenAI-compatible Chat Completions messages。
export function toDeepSeekChatMessages(messages: ChatMessage[]): DeepSeekChatMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      return { role: "system", content: message.content };
    }

    if (message.role === "user") {
      return { role: "user", content: message.content };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? "",
        ...(message.name === undefined ? {} : { name: message.name })
      };
    }

    return {
      role: "assistant",
      content: message.content.trim().length > 0 ? message.content : null,
      ...(message.reasoningContent === undefined ? {} : { reasoning_content: message.reasoningContent }),
      ...(message.toolCalls === undefined || message.toolCalls.length === 0
        ? {}
        : { tool_calls: message.toolCalls.map(toDeepSeekToolCall) })
    };
  });
}

// 把 Kodeks 的 reasoning effort 映射到 DeepSeek Thinking Mode 参数。
export function toDeepSeekThinkingOptions(reasoningEffort: ReasoningEffort): DeepSeekThinkingOptions {
  if (reasoningEffort === "none") {
    return { thinking: { type: "disabled" } };
  }

  return {
    thinking: { type: "enabled" },
    reasoning_effort: reasoningEffort === "xhigh" ? "max" : "high"
  };
}

// 把内部 tool call 转换为 Chat Completions 需要回放的 assistant tool_calls。
function toDeepSeekToolCall(toolCall: ChatToolCall): DeepSeekChatToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: stringifyToolArguments(toolCall.args)
    }
  };
}

// 合并 streaming tool_call 分片；DeepSeek/OpenAI-compatible 协议会按 index 多次追加参数文本。
function mergeToolCallChunk(
  pendingToolCalls: Map<number, PendingToolCall>,
  chunkToolCall: DeepSeekToolCallDelta
): void {
  const index = chunkToolCall.index ?? 0;
  const current = pendingToolCalls.get(index) ?? {
    id: chunkToolCall.id ?? `call_${index}`,
    name: "",
    argumentsText: ""
  };
  pendingToolCalls.set(index, {
    id: chunkToolCall.id ?? current.id,
    name: chunkToolCall.function?.name ?? current.name,
    argumentsText: current.argumentsText + (chunkToolCall.function?.arguments ?? "")
  });
}
