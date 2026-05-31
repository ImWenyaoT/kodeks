import { parseDeepSeekSse } from "../sse";
import type {
  CoreMessage,
  CoreRequest,
  DeepSeekChatMessage,
  DeepSeekChatRequest,
  DeepSeekStreamChunk,
  DeepSeekToolCallDelta,
  ReasoningEffort,
  ResponsesBridgeOptions,
  ResponsesStreamEvent,
} from "../types";

type PendingToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

// 把 Core IR 转换为 DeepSeek Chat Completions 请求。
export function toDeepSeekChatRequest(
  request: CoreRequest,
  options: { model?: string } = {},
): DeepSeekChatRequest {
  return {
    model: options.model ?? request.model,
    messages: request.messages.map(toDeepSeekChatMessage),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    ...toDeepSeekThinkingOptions(request.reasoningEffort),
    stream: true,
  };
}

// 调用 DeepSeek Chat Completions，并把 SSE 响应解析成 JSON chunk。
export async function* fetchDeepSeekStream(
  payload: DeepSeekChatRequest,
  apiKey: string,
  options: ResponsesBridgeOptions,
): AsyncIterable<DeepSeekStreamChunk> {
  const fetchImpl = options.fetch ?? fetch;
  const configuredBaseURL = options.chatCompletionsBaseURL;
  if (
    configuredBaseURL === undefined ||
    configuredBaseURL.trim().length === 0
  ) {
    yield {
      error: {
        message:
          "KODEKS_CHAT_COMPLETIONS_BASE_URL is required. Legacy DEEPSEEK_* and KODEKS_BRIDGE_DEEPSEEK_* keys have been removed.",
      },
    };
    return;
  }
  const baseURL = trimTrailingSlash(configuredBaseURL);
  const response = await fetchImpl(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": options.userAgent ?? "kodeks-responses-bridge/0.1",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || response.body === null) {
    yield {
      error: {
        message: `DeepSeek request failed: ${response.status} ${response.statusText}`,
      },
    };
    return;
  }

  yield* parseDeepSeekSse(response.body);
}

// 把 DeepSeek Chat Completions 流映射为 OpenAI Responses stream events。
export async function* fromDeepSeekStream(
  stream: AsyncIterable<DeepSeekStreamChunk> | Iterable<DeepSeekStreamChunk>,
  options: { responseId?: string; model?: string } = {},
): AsyncIterable<ResponsesStreamEvent> {
  const pendingToolCalls = new Map<number, PendingToolCall>();
  const completedOutputItems: unknown[] = [];
  let responseId = options.responseId ?? "resp_bridge";
  const model = options.model ?? "bridge";
  let outputIndex = 0;
  let messageText = "";
  let reasoningContent = "";

  for await (const chunk of stream) {
    if (chunk.error?.message !== undefined) {
      yield buildResponseFailedEvent(responseId, model, chunk.error.message);
      continue;
    }

    responseId = chunk.id ?? responseId;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (
      delta?.reasoning_content !== undefined &&
      delta.reasoning_content !== null &&
      delta.reasoning_content.length > 0
    ) {
      reasoningContent += delta.reasoning_content;
    }

    if (
      delta?.content !== undefined &&
      delta.content !== null &&
      delta.content.length > 0
    ) {
      messageText += delta.content;
      yield {
        type: "response.output_text.delta",
        delta: delta.content,
        output_index: outputIndex,
        content_index: 0,
        item_id: `msg_${responseId}`,
      };
    }

    for (const toolCall of delta?.tool_calls ?? []) {
      mergeToolCallChunk(pendingToolCalls, toolCall);
    }

    if (choice?.finish_reason === "tool_calls") {
      for (const toolCall of pendingToolCalls.values()) {
        const item = {
          id: `fc_${toolCall.id}`,
          type: "function_call" as const,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.argumentsText,
          ...(reasoningContent.length === 0
            ? {}
            : { reasoning_content: reasoningContent }),
          status: "completed" as const,
        };
        completedOutputItems.push(item);
        yield {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
        };
        outputIndex += 1;
      }
      pendingToolCalls.clear();
      yield buildResponseCompletedEvent(
        responseId,
        model,
        messageText,
        completedOutputItems,
      );
      messageText = "";
      reasoningContent = "";
      completedOutputItems.length = 0;
      continue;
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      yield buildResponseCompletedEvent(
        responseId,
        model,
        messageText,
        completedOutputItems,
      );
      messageText = "";
      reasoningContent = "";
      completedOutputItems.length = 0;
    }
  }
}

// 把 Core message 转成 DeepSeek/OpenAI Chat Completions message。
function toDeepSeekChatMessage(message: CoreMessage): DeepSeekChatMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId ?? "",
    };
  }

  if (message.role === "assistant") {
    const toolCalls = message.toolCalls ?? [];
    const hasToolCalls = toolCalls.length > 0;
    return {
      role: "assistant",
      content: hasToolCalls
        ? message.content
        : message.content.length > 0
          ? message.content
          : null,
      ...(message.reasoningContent === undefined
        ? {}
        : { reasoning_content: message.reasoningContent }),
      ...(!hasToolCalls
        ? {}
        : {
            tool_calls: toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: toolCall.argumentsText,
              },
            })),
          }),
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

// 把 Kodeks reasoning effort 映射到 DeepSeek Thinking Mode。
function toDeepSeekThinkingOptions(
  reasoningEffort: ReasoningEffort,
): Pick<DeepSeekChatRequest, "thinking" | "reasoning_effort"> {
  if (reasoningEffort === "none") {
    return { thinking: { type: "disabled" } };
  }

  return {
    thinking: { type: "enabled" },
    reasoning_effort: reasoningEffort === "xhigh" ? "max" : "high",
  };
}

// 创建 Responses completion event，保持文本和 function_call output 形态一致。
function buildResponseCompletedEvent(
  responseId: string,
  model: string,
  messageText: string,
  completedOutputItems: unknown[],
): Extract<ResponsesStreamEvent, { type: "response.completed" }> {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      model,
      status: "completed",
      output: buildCompletedOutput(
        responseId,
        messageText,
        completedOutputItems,
      ),
    },
  };
}

// 创建 SDK 可识别的终止失败事件，避免上游错误被误读成缺少 final response。
function buildResponseFailedEvent(
  responseId: string,
  model: string,
  message: string,
): Extract<ResponsesStreamEvent, { type: "response.failed" }> {
  const text = `MoonBridge upstream failed: ${message}`;
  return {
    type: "response.failed",
    response: {
      id: responseId,
      model,
      status: "failed",
      error: { message },
      output: [
        {
          id: `msg_${responseId}_failed`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    },
  };
}

// 构造 OpenAI Agents SDK 消费的 Responses output items。
function buildCompletedOutput(
  responseId: string,
  messageText: string,
  completedOutputItems: unknown[],
): unknown[] {
  return [
    ...(messageText.length === 0
      ? []
      : [
          {
            id: `msg_${responseId}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: messageText }],
          },
        ]),
    ...completedOutputItems,
  ];
}

// 合并 Chat Completions tool_call delta 分片。
function mergeToolCallChunk(
  pendingToolCalls: Map<number, PendingToolCall>,
  chunk: DeepSeekToolCallDelta,
): void {
  const index = chunk.index ?? 0;
  const current = pendingToolCalls.get(index) ?? {
    id: chunk.id ?? `call_${index}`,
    name: "",
    argumentsText: "",
  };
  pendingToolCalls.set(index, {
    id: chunk.id ?? current.id,
    name: chunk.function?.name ?? current.name,
    argumentsText: current.argumentsText + (chunk.function?.arguments ?? ""),
  });
}

// 移除 URL 末尾斜杠，避免拼接双斜杠。
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
