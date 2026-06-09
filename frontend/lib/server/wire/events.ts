// frontend/lib/server/wire/events.ts
// Kodeks 线缝事件契约（迁移自 Python：contracts.py / sse.py / ui_transport.py / runtime.py）。
// 两套词汇：
//  · 原始 runtime 事件（snake_case，/api/chat/stream）—— 10 种。
//  · UI transport 事件（type 为 kebab-case、字段为 camelCase，/api/chat/ui）—— 8 种。
// 本模块是纯函数 + Zod schema，被存储/路由/适配器共用；不依赖 Next.js 运行时。
import { z } from 'zod'

// ── 原始 runtime 事件（snake_case）──────────────────────────────────────────

/** plan_artifact 内嵌的计划工件（StoredPlanArtifact，camelCase，见 contracts.py:77-89）。 */
export const storedPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  details: z.string().nullable(),
})

export const storedPlanArtifactSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  summary: z.string(),
  steps: z.array(storedPlanStepSchema),
  status: z.enum(['active', 'archived']),
  sourceMessageId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** runtime 工具状态：注册表状态经 _map_tool_status 映射后的三态（responses_tool_loop.py:244-251）。 */
export const runtimeToolStatusSchema = z.enum(['ok', 'approval_required', 'error'])

export const rawEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_created'), session_id: z.string() }),
  z.object({ type: z.literal('text_delta'), delta: z.string(), session_id: z.string() }),
  z.object({ type: z.literal('assistant_status'), message: z.string(), session_id: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    tool_call_id: z.string(),
    tool_name: z.string(),
    tool_arguments: z.record(z.string(), z.unknown()),
    session_id: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_call_id: z.string(),
    tool_name: z.string(),
    tool_status: runtimeToolStatusSchema,
    tool_output: z.string(),
    session_id: z.string(),
  }),
  z.object({
    type: z.literal('approval_required'),
    approval_id: z.string(),
    tool_call_id: z.string(),
    message: z.string(),
    command: z.string(),
    command_hash: z.string(),
    session_id: z.string(),
  }),
  z.object({
    type: z.literal('plan_artifact'),
    action: z.enum(['recovered', 'created']),
    plan: storedPlanArtifactSchema,
    session_id: z.string(),
  }),
  z.object({
    type: z.literal('memory_recalled'),
    memory_ids: z.array(z.string()),
    memory_layers: z.record(z.string(), z.number()),
    session_id: z.string(),
  }),
  z.object({ type: z.literal('response_completed'), response_id: z.string(), session_id: z.string() }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string(),
    session_id: z.string(),
  }),
])

export type RawEvent = z.infer<typeof rawEventSchema>

/** 全部原始事件 type 字面量（顺序仅作清单用途）。 */
export const RAW_EVENT_TYPES = [
  'session_created',
  'text_delta',
  'assistant_status',
  'tool_call',
  'tool_result',
  'approval_required',
  'plan_artifact',
  'memory_recalled',
  'response_completed',
  'error',
] as const

// ── UI transport 事件（kebab type + camelCase 字段）──────────────────────────

export const uiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  z.object({ type: z.literal('status'), message: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('text-delta'), delta: z.string(), sessionId: z.string() }),
  z.object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    result: z.string(),
    status: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    type: z.literal('approval-required'),
    approvalId: z.string(),
    toolCallId: z.string(),
    message: z.string(),
    command: z.string(),
    commandHash: z.string(),
    sessionId: z.string(),
  }),
  z.object({ type: z.literal('finish'), responseId: z.string(), sessionId: z.string() }),
  z.object({
    type: z.literal('error'),
    errorText: z.string(),
    code: z.unknown(),
    sessionId: z.string(),
  }),
])

export type UiEvent = z.infer<typeof uiEventSchema>

// ── SSE 帧编码（字节复刻 sse.py:10-13）──────────────────────────────────────

/**
 * 以与 Python `json.dumps(data, separators=(',', ':'))` 逐字节一致的方式序列化：
 * 紧凑（无空格，JSON.stringify 默认即是）+ 非 ASCII 字符（码点 ≥ 0x80）转义为 `\uXXXX`
 * （复刻 ensure_ascii=True 默认行为）。按 UTF-16 码元逐个转义，自然复刻 Python 对星形平面字符的代理对转义。
 */
export function encodeJsonAsciiCompact(data: unknown): string {
  return JSON.stringify(data).replace(/[-￿]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

/**
 * 编码一条具名 SSE 帧：`event: {type}\ndata: {紧凑JSON}\n\n`。
 * 与 Python sse_frame 逐字节一致（event:/data: 后各一个空格，结尾双换行）。
 */
export function encodeSseFrame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${encodeJsonAsciiCompact(data)}\n\n`
}

// ── runtime 事件 → UI transport 事件（移植 ui_transport.py:9-66）─────────────

/** 复刻 Python `str(value or "")`：任何 falsy 值（含空串/0/None）→ ""，否则 String(value)。 */
function s(value: unknown): string {
  return value ? String(value) : ''
}

/**
 * 把一个原始 runtime 事件映射为 UI transport payload；无对应映射的事件返回 null（会被丢弃）。
 * memory_recalled / plan_artifact 等有意返回 null（与 Python 一致）。
 * 字段顺序严格对齐 ui_transport.py 的 dict 字面量顺序，以保证 SSE 字节级一致。
 */
export function toUiTransportPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  const eventType = event.type
  const sessionId = s(event.session_id)
  switch (eventType) {
    case 'session_created':
      return { type: 'session', sessionId }
    case 'assistant_status':
      return { type: 'status', message: s(event.message), sessionId }
    case 'text_delta':
      return { type: 'text-delta', delta: s(event.delta), sessionId }
    case 'tool_call':
      return {
        type: 'tool-call',
        toolCallId: s(event.tool_call_id),
        toolName: s(event.tool_name),
        args: event.tool_arguments ?? {},
        sessionId,
      }
    case 'tool_result':
      return {
        type: 'tool-result',
        toolCallId: s(event.tool_call_id),
        toolName: s(event.tool_name),
        result: s(event.tool_output),
        status: s(event.tool_status),
        sessionId,
      }
    case 'approval_required':
      return {
        type: 'approval-required',
        approvalId: s(event.approval_id),
        toolCallId: s(event.tool_call_id),
        message: s(event.message),
        command: s(event.command),
        commandHash: s(event.command_hash),
        sessionId,
      }
    case 'response_completed':
      return { type: 'finish', responseId: s(event.response_id), sessionId }
    case 'error':
      // code 原样透传（唯一不强制 str 的字段）；undefined → null 以匹配 Python None 的 `"code":null` 输出。
      return { type: 'error', errorText: s(event.message), code: event.code ?? null, sessionId }
    default:
      return null
  }
}
