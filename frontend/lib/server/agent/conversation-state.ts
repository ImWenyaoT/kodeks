// frontend/lib/server/agent/conversation-state.ts
// transcript → Responses 输入项重建：逐字节忠实移植自 Python src/kodeks/conversation_state.py。
// user→message/input_text；assistant→output_text(+function_call items)；tool→function_call_output。
//
// 保真红线（见 30-runtime-loop.md「Replay」、80-oracle §H）：
//  · arguments 用紧凑 JSON（JSON.stringify 默认无空格，对应 Python separators=(",",":")）。
//  · function_call item 仅当 content.reasoningContent 为 str 时附 reasoning_content（snake_case，排在 arguments 之后）。
//  · _content_text：str 原样；dict 取 .text（str）；否则紧凑 JSON 序列化整个 value。
//  · 输入侧用 snake_case reasoning_content（replay），与持久化 content 的 camelCase reasoningContent 区分（保真风险 6）。
import type { StoredMessage } from '../storage'

/** Responses 输入项（任意 JSON 形状，键序按构造顺序保真）。 */
export type ResponsesInputItem = Record<string, unknown>

/** 暴露 sessions.getTranscript 的最小数据库接口（异步，M2 存储）。 */
export interface TranscriptSource {
  sessions: {
    getTranscript(sessionId: string): Promise<StoredMessage[]>
  }
}

/**
 * 把持久化 transcript 行转成 Responses 兼容输入项（移植 build_responses_input_from_transcript，conversation_state.py:12-17）。
 * 异步：getTranscript 在 TS 侧返回 Promise（M2 存储异步）。
 */
export async function buildResponsesInputFromTranscript(
  database: TranscriptSource,
  sessionId: string,
): Promise<ResponsesInputItem[]> {
  return buildResponsesInputFromMessages(await database.sessions.getTranscript(sessionId))
}

/**
 * 把存储的 transcript 消息逐条转成 Responses 兼容输入项（移植 build_responses_input_from_messages，conversation_state.py:20-71）。
 * 分支顺序：tool → function_call_output；assistant(含 toolCalls) → 可选 message + function_call 项；
 * assistant(纯文本) → message；其它(user 等) → user message。
 */
export function buildResponsesInputFromMessages(
  messages: Iterable<StoredMessage>,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      const content = dictContent(message.content)
      items.push({
        type: 'function_call_output',
        call_id: String(content.toolCallId || ''),
        output: contentText(message.content),
      })
      continue
    }
    if (message.role === 'assistant') {
      const content = dictContent(message.content)
      const toolCalls = content.toolCalls
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const text = contentText(message.content)
        if (text) {
          items.push(assistantMessageInputItem(text))
        }
        for (const toolCall of toolCalls) {
          if (!isDict(toolCall)) {
            continue
          }
          const item: ResponsesInputItem = {
            type: 'function_call',
            call_id: String(toolCall.id || ''),
            name: String(toolCall.name || ''),
            // 紧凑 JSON（对应 Python json.dumps(... separators=(",",":"))）。
            arguments: JSON.stringify(toolCall.args || {}),
          }
          // 仅当 reasoningContent 为 str 时附 snake_case reasoning_content（排在 arguments 之后）。
          if (typeof content.reasoningContent === 'string') {
            item.reasoning_content = content.reasoningContent
          }
          items.push(item)
        }
        continue
      }
      const text = contentText(message.content)
      if (text) {
        items.push(assistantMessageInputItem(text))
      }
      continue
    }
    const text = contentText(message.content)
    if (text) {
      items.push(userMessageInputItem(text))
    }
  }
  return items
}

/** 构建一条 Responses user message 输入项（移植 _user_message_input_item，conversation_state.py:74-81）。 */
function userMessageInputItem(text: string): ResponsesInputItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }
}

/** 构建一条 Responses assistant message replay 项（移植 _assistant_message_input_item，conversation_state.py:84-97）。 */
function assistantMessageInputItem(text: string): ResponsesInputItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
  }
}

/** 把消息 content 当作字典返回（移植 _dict_content，conversation_state.py:100-103）。 */
function dictContent(value: unknown): Record<string, unknown> {
  return isDict(value) ? value : {}
}

/**
 * 从存储 transcript content 读出文本（移植 _content_text，conversation_state.py:106-115）。
 * str 原样；dict 取 .text（str）；否则紧凑 JSON 序列化整个 value。
 */
function contentText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (isDict(value)) {
    const text = value.text
    if (typeof text === 'string') {
      return text
    }
  }
  return JSON.stringify(value)
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
