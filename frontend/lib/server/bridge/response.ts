// frontend/lib/server/bridge/response.ts
// MoonBridge 响应方向：把 OpenAI 兼容 Chat Completions（DeepSeek）的流式 chunk
// 映射为 OpenAI Responses 流式事件。逐字节忠实移植自 Python providers/bridge.py:179-253,352-433,436-444。
//
// 保真红线（见 10-bridge.md「保真风险」）：
//  · 只发 Python 的精简 4 事件:output_text.delta / output_item.done（仅 tool_calls 完成、单次 done）
//    / completed / failed。绝不发 created/in_progress/output_item.added/content_part.* 等 spike 完整链。
//  · reasoning_content 只累积、不作为事件输出,仅在 tool_call item 上附带。
//  · 文本 delta 的 output_index 恒 0、content_index 恒 0;tool item 的 output_index 从 0 起每个 +1（与文本不共享计数）。
//  · _merge_tool_call_chunk:按 index 分桶,桶初值 id='call_'+index;id/name 整体覆盖;arguments 累积拼接。

/** 单个 pending tool call 的累积态:id/name 覆盖,argumentsText 拼接。 */
type PendingToolCall = { id: string; name: string; argumentsText: string }

/** 复刻 Python `isinstance(x, str)`。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 复刻 Python `isinstance(x, dict)`:普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把同步 Iterable 或 AsyncIterable 统一适配为 async generator（移植 _aiter,bridge.py:436-444）。
 * 测试传普通数组（同步 Iterable）,生产传上游 fetch 流（AsyncIterable）;两者都支持。
 */
async function* aiter(
  stream: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
): AsyncGenerator<Record<string, unknown>> {
  // 同步 Iterable 优先（数组等）;否则按 AsyncIterable 处理。
  if (Symbol.iterator in stream && typeof (stream as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const item of stream as Iterable<Record<string, unknown>>) {
      yield item
    }
    return
  }
  for await (const item of stream as AsyncIterable<Record<string, unknown>>) {
    yield item
  }
}

/**
 * 取 chunk 的第一个 choice（移植 _first_choice,bridge.py:352-356）。
 * choices 是非空 list 且首元素是 dict 时返回它,否则返回 {}。
 */
function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> {
  const choices = chunk.choices
  if (Array.isArray(choices) && choices.length > 0 && isDict(choices[0])) {
    return choices[0]
  }
  return {}
}

/**
 * 把一个 tool_call 增量 chunk 合并进 pending 桶（移植 _merge_tool_call_chunk,bridge.py:359-373）。
 * 按 index（int(index or 0)）分桶,桶初值 id='call_'+index;id/function.name 出现即整体覆盖;
 * function.arguments 累积拼接（+=）。
 */
function mergeToolCallChunk(pending: Map<number, PendingToolCall>, toolCall: unknown): void {
  if (!isDict(toolCall)) return
  // int(tool_call.get("index") or 0):缺失/0/None/falsy 都归 0。
  const rawIndex = toolCall.index
  const index = rawIndex ? Math.trunc(Number(rawIndex)) : 0
  let current = pending.get(index)
  if (current === undefined) {
    current = { id: `call_${index}`, name: '', argumentsText: '' }
    pending.set(index, current)
  }
  if (isString(toolCall.id)) {
    current.id = toolCall.id
  }
  const fn = toolCall.function
  if (isDict(fn)) {
    if (isString(fn.name)) {
      current.name = fn.name
    }
    if (isString(fn.arguments)) {
      current.argumentsText += fn.arguments
    }
  }
}

/**
 * 构造 response.completed 事件（移植 _response_completed_event,bridge.py:376-404）。
 * output:message_text 非空才放 message item（在前）,再 extend tool items。
 */
function responseCompletedEvent(
  responseId: string,
  model: string,
  messageText: string,
  completedOutputItems: Record<string, unknown>[],
): Record<string, unknown> {
  const output: Record<string, unknown>[] = []
  if (messageText) {
    output.push({
      id: `msg_${responseId}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: messageText, annotations: [] }],
    })
  }
  output.push(...completedOutputItems)
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      model,
      status: 'completed',
      output,
    },
  }
}

/**
 * 构造 response.failed 事件（移植 _response_failed_event,bridge.py:407-433）。
 * text 前缀逐字:'MoonBridge upstream failed: '。
 */
function responseFailedEvent(
  responseId: string,
  model: string,
  message: string,
): Record<string, unknown> {
  return {
    type: 'response.failed',
    response: {
      id: responseId,
      model,
      status: 'failed',
      error: { message },
      output: [
        {
          id: `msg_${responseId}_failed`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: `MoonBridge upstream failed: ${message}`,
              annotations: [],
            },
          ],
        },
      ],
    },
  }
}

/**
 * 把 Chat Completions（DeepSeek）流式 chunk 映射为 Responses 流式事件（移植 from_deepseek_stream,bridge.py:179-253）。
 * async generator,逐 chunk 处理:error 短路 → failed;reasoning_content 仅累积;content → output_text.delta；
 * tool_calls → 仅累积;finish_reason=='tool_calls' → 每个 tool 发 output_item.done 后发 completed；
 * 其它非空 finish_reason → 直接发 completed。
 * @param chunks 上游 chunk 序列,同时接受同步 Iterable（数组）与 AsyncIterable。
 * @param options responseId 默认 'resp_bridge'（被 chunk.id 覆盖）;model 默认 'bridge'。
 */
export async function* fromDeepseekStream(
  chunks: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  options: { responseId?: string; model?: string } = {},
): AsyncGenerator<Record<string, unknown>> {
  let responseId = options.responseId ?? 'resp_bridge'
  const model = options.model ?? 'bridge'

  const pendingToolCalls = new Map<number, PendingToolCall>()
  let completedOutputItems: Record<string, unknown>[] = []
  let outputIndex = 0
  let messageText = ''
  let reasoningContent = ''

  for await (const chunk of aiter(chunks)) {
    const error = chunk.error
    if (isDict(error) && isString(error.message)) {
      yield responseFailedEvent(responseId, model, error.message)
      continue
    }
    // 每个 chunk 用其 id 覆盖 response_id（str(chunk.id or response_id)）。
    responseId = String(chunk.id || responseId)
    const choice = firstChoice(chunk)
    const rawDelta = choice.delta
    const delta: Record<string, unknown> = isDict(rawDelta) ? rawDelta : {}

    // reasoning_content（非空 str）→ 累加,不发事件。
    const reasoningDelta = delta.reasoning_content
    if (isString(reasoningDelta) && reasoningDelta) {
      reasoningContent += reasoningDelta
    }

    // content（非空 str）→ 累加并发 output_text.delta（output_index 恒 0、content_index 恒 0）。
    const content = delta.content
    if (isString(content) && content) {
      messageText += content
      yield {
        type: 'response.output_text.delta',
        delta: content,
        output_index: outputIndex,
        content_index: 0,
        item_id: `msg_${responseId}`,
      }
    }

    // tool_calls（list）→ 逐项合并到 pending,不发事件。
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (const toolCall of toolCalls) {
      mergeToolCallChunk(pendingToolCalls, toolCall)
    }

    const finishReason = choice.finish_reason ?? null
    if (finishReason === 'tool_calls') {
      // 每个 pending tool 发一个 output_item.done（type=function_call,单次 done）,output_index 自增。
      for (const toolCall of pendingToolCalls.values()) {
        const item: Record<string, unknown> = {
          id: `fc_${toolCall.id}`,
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.argumentsText,
          status: 'completed',
        }
        // reasoning_content 非空才附带（仅在 tool_call item 上,不作为独立事件）。
        if (reasoningContent) {
          item.reasoning_content = reasoningContent
        }
        completedOutputItems.push(item)
        yield {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item,
        }
        outputIndex += 1
      }
      pendingToolCalls.clear()
      yield responseCompletedEvent(responseId, model, messageText, completedOutputItems)
      messageText = ''
      reasoningContent = ''
      completedOutputItems = []
    } else if (finishReason !== null) {
      // 任何其它非 None finish_reason（stop/length/content_filter…）→ 直接发 completed 并重置。
      yield responseCompletedEvent(responseId, model, messageText, completedOutputItems)
      messageText = ''
      reasoningContent = ''
      completedOutputItems = []
    }
  }
}
