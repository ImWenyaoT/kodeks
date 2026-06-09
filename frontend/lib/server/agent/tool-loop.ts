// frontend/lib/server/agent/tool-loop.ts
// Responses function-call continuation 循环助手：逐字节忠实移植自 Python src/kodeks/responses_tool_loop.py。
// handleOutputItem（async generator）/ appendToolContinuationMessages / ToolRoundState /
// parse helpers / mapToolStatus / artifactThresholdBytes。
//
// 保真红线（见 30-runtime-loop.md「handle_output_item」、80-oracle §B/§H）：
//  · 事件顺序：assistant_status → tool_call → (执行) → tool_result → (审批时) approval_required；审计 tool_called/tool_failed/tool_result。
//  · 未知工具：output="Unknown tool requested by model: <name>"，halt_tool_loop=true，发 tool_result(error)+error(model_requested_unknown_tool) 后 return。
//  · status==ok 才经 compactToolResult（阈值 env KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES 默认 4096，max(1,value)）。
//  · mapped_status != approval_required 才把记录追加进 toolCalls/toolMessages（approval 不进 continuation）。
//  · approval_id=parsed.approvalId||""；message=parsed.reason||"Command requires approval"。
import { createHash } from 'node:crypto'
import type { KodeksDatabase } from '../storage'
import type { RuntimeEnv } from '../config'
import type {
  ToolArguments,
  ToolExecutionResult,
  ToolExecutionStatus,
} from '../tools/types'

/** runtime 工具状态三态（移植 RuntimeToolStatus，responses_tool_loop.py:18）。 */
export type RuntimeToolStatus = 'ok' | 'approval_required' | 'error'

/** 本循环所需的最小工具注册表接口（移植 ToolRegistryLike，responses_tool_loop.py:21-33）。 */
export interface ToolRegistryLike {
  has(toolName: string): boolean
  execute(
    toolName: string,
    args: ToolArguments,
    context?: { sessionId?: string | null; toolCallId?: string | null },
  ): Promise<ToolExecutionResult>
}

/** 持久化的 assistant 工具调用记录（continuation replay 用，移植 ToolCallRecord，responses_tool_loop.py:36-41）。 */
export interface ToolCallRecord {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 持久化的工具输出记录（continuation replay 用，移植 ToolMessageRecord，responses_tool_loop.py:44-50）。 */
export interface ToolMessageRecord {
  toolCallId: string
  name: string
  output: string
}

/**
 * 跟踪决定当前模型 turn 是否继续的工具调用状态（移植 ToolRoundState dataclass，responses_tool_loop.py:52-60）。
 * 三个控制位：toolMessages（有工具结果待续轮）、waitingForApproval（命中审批暂停）、haltToolLoop（未知工具硬停）。
 */
export class ToolRoundState {
  toolCalls: ToolCallRecord[] = []
  toolMessages: ToolMessageRecord[] = []
  reasoningContent: string | null = null
  waitingForApproval = false
  haltToolLoop = false
}

/** handleOutputItem 所需的 emit 事件形状（任意 JSON，键序保真）。 */
export type RuntimeEvent = Record<string, unknown>

/**
 * 执行完成的 Responses function_call 项并经本地工具透出运行时事件（移植 handle_output_item，responses_tool_loop.py:63-175）。
 * 仅处理 item.type == "function_call"，否则直接返回。
 * @param item 模型产出的 output item（应为 function_call dict）
 * @param registry 本地工具注册表
 * @param database M2 存储门面（审计/压缩）
 * @param workspaceRoot 工作区根（用于 compactToolResult 落盘）
 * @param runtimeEnv 运行时 env（读取压缩阈值）
 * @param sessionId 当前会话 id
 * @param toolState 本轮工具状态机（就地更新）
 * @param allowedToolNames 当前模式允许执行的工具名集合；null 表示只检查注册表
 */
export async function* handleOutputItem(
  item: unknown,
  registry: ToolRegistryLike,
  database: KodeksDatabase,
  workspaceRoot: string,
  runtimeEnv: RuntimeEnv,
  sessionId: string,
  toolState: ToolRoundState,
  allowedToolNames: ReadonlySet<string> | null = null,
): AsyncGenerator<RuntimeEvent> {
  if (!isDict(item) || item.type !== 'function_call') {
    return
  }
  const toolCallId = String(item.call_id || item.id || '')
  const toolName = String(item.name || '')
  const toolArguments = parseToolArguments(item.arguments)
  yield {
    type: 'assistant_status',
    message: `Using ${toolName}`,
    session_id: sessionId,
  }
  yield {
    type: 'tool_call',
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_arguments: toolArguments,
    session_id: sessionId,
  }
  await database.auditLog.record(sessionId, 'tool_called', {
    toolCallId,
    toolName,
    arguments: toolArguments,
  })
  if (!registry.has(toolName)) {
    const output = `Unknown tool requested by model: ${toolName}`
    toolState.haltToolLoop = true
    await database.auditLog.record(sessionId, 'tool_failed', {
      toolCallId,
      toolName,
      reason: output,
    })
    yield {
      type: 'tool_result',
      tool_call_id: toolCallId,
      tool_name: toolName,
      tool_status: 'error',
      tool_output: output,
      session_id: sessionId,
    }
    yield errorEvent(output, sessionId, 'model_requested_unknown_tool')
    return
  }
  if (allowedToolNames !== null && !allowedToolNames.has(toolName)) {
    const output = `Tool not allowed in the current mode: ${toolName}`
    toolState.haltToolLoop = true
    await database.auditLog.record(sessionId, 'tool_failed', {
      toolCallId,
      toolName,
      reason: output,
    })
    yield {
      type: 'tool_result',
      tool_call_id: toolCallId,
      tool_name: toolName,
      tool_status: 'error',
      tool_output: output,
      session_id: sessionId,
    }
    yield errorEvent(output, sessionId, 'tool_not_allowed_in_mode')
    return
  }
  const result = await registry.execute(toolName, toolArguments, {
    sessionId,
    toolCallId,
  })
  const mappedStatus = mapToolStatus(result.status)
  let toolOutput = result.output
  if (mappedStatus === 'ok') {
    toolOutput = await database.memories.compactToolResult(
      workspaceRoot,
      sessionId,
      toolCallId || null,
      toolName,
      result.output,
      artifactThresholdBytes(runtimeEnv),
    )
  }
  const parsedOutput = parseJsonObject(toolOutput)
  if (typeof item.reasoning_content === 'string') {
    toolState.reasoningContent = String(item.reasoning_content)
  }
  if (mappedStatus !== 'approval_required') {
    toolState.toolCalls.push({ id: toolCallId, name: toolName, args: { ...toolArguments } })
    toolState.toolMessages.push({
      toolCallId,
      name: toolName,
      output: toolOutput,
    })
  }
  yield {
    type: 'tool_result',
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_status: mappedStatus,
    tool_output: toolOutput,
    session_id: sessionId,
  }
  await database.auditLog.record(sessionId, 'tool_result', {
    toolCallId,
    toolName,
    status: mappedStatus,
  })
  if (mappedStatus === 'approval_required') {
    toolState.waitingForApproval = true
    yield {
      type: 'approval_required',
      approval_id: String(parsedOutput.approvalId || ''),
      tool_call_id: toolCallId,
      message: String(parsedOutput.reason || 'Command requires approval'),
      command: String(parsedOutput.command || ''),
      command_hash: commandHash(String(parsedOutput.command || '')),
      session_id: sessionId,
    }
  }
}

/**
 * 为 continuation 持久化 assistant 工具调用与工具输出消息（移植 append_tool_continuation_messages，responses_tool_loop.py:178-204）。
 * append 一条 assistant 消息（content={text,toolCalls[,reasoningContent]}），再为每个工具输出 append 一条 tool 消息。
 * 异步：appendMessage 在 TS 侧返回 Promise（M2 存储异步）。
 */
export async function appendToolContinuationMessages(
  database: KodeksDatabase,
  sessionId: string,
  assistantText: string,
  reasoningContent: string | null,
  toolCalls: ToolCallRecord[],
  toolMessages: ToolMessageRecord[],
): Promise<void> {
  const assistantContent: Record<string, unknown> = {
    text: assistantText,
    toolCalls,
  }
  if (reasoningContent) {
    assistantContent.reasoningContent = reasoningContent
  }
  await database.sessions.appendMessage(sessionId, 'assistant', assistantContent)
  for (const message of toolMessages) {
    await database.sessions.appendMessage(sessionId, 'tool', {
      text: message.output,
      toolCallId: message.toolCallId,
      name: message.name,
    })
  }
}

/** 从模型/工具输出解析一个 JSON 对象（移植 parse_json_object，responses_tool_loop.py:207-214）。 */
export function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  return isDict(parsed) ? parsed : {}
}

/**
 * 读取大工具输出的内存 artifact 阈值（移植 _artifact_threshold_bytes，responses_tool_loop.py:217-227）。
 * 未设/非法值回退 4096；其它取 max(1, value)。
 */
export function artifactThresholdBytes(env: RuntimeEnv): number {
  const raw = env.KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES
  if (raw === undefined || raw === null) {
    return 4096
  }
  // 复刻 Python int(raw)：仅接受纯十进制整数字面量（含正负号/前后空白），否则 ValueError → 4096。
  const trimmed = raw.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return 4096
  }
  const value = Number.parseInt(trimmed, 10)
  if (Number.isNaN(value)) {
    return 4096
  }
  return Math.max(1, value)
}

/**
 * 从 JSON 或映射解析 Responses function-call 参数（移植 _parse_tool_arguments，responses_tool_loop.py:230-241）。
 * dict 直接复制；str 走 JSON.parse（失败/非 dict 返回 {}）；其它返回 {}。
 */
export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isDict(value)) {
    return { ...value }
  }
  if (typeof value !== 'string') {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return {}
  }
  return isDict(parsed) ? parsed : {}
}

/**
 * 把注册表状态映射为运行时事件状态契约（移植 _map_tool_status，responses_tool_loop.py:244-251）。
 * completed→ok，approval_required→approval_required，其它(failed)→error。
 */
export function mapToolStatus(status: ToolExecutionStatus): RuntimeToolStatus {
  if (status === 'completed') {
    return 'ok'
  }
  if (status === 'approval_required') {
    return 'approval_required'
  }
  return 'error'
}

/** 构建一个运行时 error 事件（移植 _error_event，responses_tool_loop.py:254-264）。 */
function errorEvent(message: string, sessionId: string, code = 'runtime_error'): RuntimeEvent {
  return {
    type: 'error',
    message,
    code,
    session_id: sessionId,
  }
}

/** 返回审批命令的 SHA256 digest，用于 UI 展示与批准时绑定。 */
function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
