// frontend/lib/server/agent/runtime.ts
// 顶层 Python chat turn 入口：逐字节忠实移植自 Python src/kodeks/runtime.py。
// runPythonChatTurn（async generator）：建会话、记审计、emit 头部事件、装配 registry/context、跑工具循环、收尾持久化。
//
// 保真红线（见 30-runtime-loop.md「顶层入口」、80-oracle §B）：
//  · MAX_TOOL_LOOP_TURNS=12；input 缺失→error "Input is required."。
//  · 顺序：append user 消息 → audit turn_started → harness 审计 → emit session_created →
//    (active plan) plan_artifact(recovered) → memory_recalled(命中) → 跑循环。
//  · 收尾 completeAssistantTurn：assistant 非空才 append + (plan 模式) upsert + plan_artifact(created) + plan_checkpointed；
//    总是 audit turn_completed + emit response_completed。
//  · 顶层错误：ModelConfigurationError → message 以 provider-required 开头则 model_provider_missing，否则用 .code；其它 → runtime_error。
import { ModelConfigurationError, type RuntimeEnv } from '../config'
import { buildPlanArtifactContent } from '../plans'
import { createDatabase, type KodeksDatabase } from '../storage'
import { buildDefaultToolRegistry } from '../tools/registry'
import type { ToolRegistryServices } from '../tools/types'
import { WorkspaceService } from '../workspace'
import {
  bodyWithRuntimeContext,
  buildMemoryContext,
  memoryContextIds,
  memoryContextLayerCounts,
  selectedFilesFromBody,
} from './context'
import { selectHarnessPattern } from './harness'
import {
  runResponsesToolLoop,
  type ResponsesEventFactory,
} from './responses-runtime'
import type { RuntimeEvent } from './tool-loop'

/** 工具续跑轮数上界（移植 MAX_TOOL_LOOP_TURNS，runtime.py:29）。 */
export const MAX_TOOL_LOOP_TURNS = 12

/**
 * 跑一个 Python chat turn 并 emit Kodeks SSE 事件契约（移植 run_python_chat_turn，runtime.py:32-145）。
 * @param body 请求体（input/session_id/mode/selectedFiles/parentSessionId/model/...）。
 * @param database M2 存储门面（已由 createDatabase 异步建好）。
 * @param workspaceRoot 工作区根目录。
 * @param env 运行时 env（默认 process.env，对应 Python `os.environ if env is None`）。
 * @param responsesEventFactory 可选注入工厂（假模型）；为 null 时走 liveResponsesEvents（真实模型）。
 */
export async function* runPythonChatTurn(
  body: Record<string, unknown>,
  database: KodeksDatabase,
  workspaceRoot: string,
  env: RuntimeEnv | null = null,
  responsesEventFactory: ResponsesEventFactory | null = null,
): AsyncGenerator<RuntimeEvent> {
  const runtimeEnv: RuntimeEnv = env === null ? (process.env as RuntimeEnv) : env
  const userInput = stringOrNull(body.input)
  const requestedSessionId = stringOrNull(body.session_id)
  if (userInput === null) {
    yield errorEvent('Input is required.', requestedSessionId || '')
    return
  }

  const mode = body.mode === 'plan' ? 'plan' : 'act'
  const parentSessionId = parentSessionIdOf(body)
  const session = await ensureSession(
    database,
    requestedSessionId,
    mode,
    workspaceRoot,
    parentSessionId,
  )
  const sessionId = session.id
  await database.sessions.appendMessage(sessionId, 'user', userInput)
  await database.auditLog.record(sessionId, 'turn_started', {
    mode,
    resumed: requestedSessionId !== null,
  })
  const harnessDecision = selectHarnessPattern(userInput, mode)
  await database.auditLog.record(
    sessionId,
    'harness_pattern_selected',
    harnessDecision.toPayload(),
  )
  yield { type: 'session_created', session_id: sessionId }

  const activePlan = await database.plans.getActiveBySession(sessionId)
  if (activePlan !== null) {
    yield {
      type: 'plan_artifact',
      action: 'recovered',
      plan: activePlan,
      session_id: sessionId,
    }
  }
  const memoryContext = await buildMemoryContext(database, userInput)
  const memoryIds = memoryContextIds(memoryContext)
  if (memoryIds.length > 0) {
    yield {
      type: 'memory_recalled',
      memory_ids: memoryIds,
      memory_layers: memoryContextLayerCounts(memoryContext),
      session_id: sessionId,
    }
    await database.auditLog.record(sessionId, 'memory_recalled', {
      memoryIds,
      layers: memoryContextLayerCounts(memoryContext),
    })
  }

  const workspace = new WorkspaceService(workspaceRoot)
  const services: ToolRegistryServices = {
    workspace,
    database,
    environment: runtimeEnv,
  }
  const registry = buildDefaultToolRegistry(services)
  const selectedFiles = selectedFilesFromBody(body)
  const runtimeBody = bodyWithRuntimeContext(
    body,
    mode,
    activePlan,
    memoryContext,
    selectedFiles,
    harnessDecision,
  )

  /** 为本运行时会话持久化最终 assistant turn（移植 complete_assistant_turn 闭包，runtime.py:103-116）。 */
  async function* completeAssistantTurn(
    assistantText: string,
    responseId: string,
  ): AsyncGenerator<RuntimeEvent> {
    yield* persistCompletedAssistantTurn(
      database,
      sessionId,
      mode,
      userInput as string,
      assistantText,
      responseId,
    )
  }

  try {
    yield* runResponsesToolLoop({
      body,
      runtimeBody,
      database,
      workspaceRoot,
      runtimeEnv,
      sessionId,
      registry,
      completeAssistantTurn,
      responsesEventFactory,
      maxToolLoopTurns: MAX_TOOL_LOOP_TURNS,
    })
    return
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      const message = String(error.message)
      const code =
        message.startsWith('A model provider is required.') ||
        message.startsWith('An OpenAI-compatible Chat Completions provider is required.')
          ? 'model_provider_missing'
          : error.code
      yield errorEvent(message, sessionId, code)
      return
    }
    yield errorEvent(errorMessage(error), sessionId, 'runtime_error')
    return
  }
}

/**
 * 持久化最终 assistant turn 并 emit plan/completion 事件（移植 _persist_completed_assistant_turn，runtime.py:148-191）。
 * assistant_text 非空才 append + (plan 模式) upsert + plan_artifact(created) + 审计 plan_checkpointed；
 * 总是 audit turn_completed（assistantBytes = UTF-8 字节长度）+ emit response_completed。
 */
async function* persistCompletedAssistantTurn(
  database: KodeksDatabase,
  sessionId: string,
  mode: string,
  userInput: string,
  assistantText: string,
  responseId: string,
): AsyncGenerator<RuntimeEvent> {
  if (assistantText) {
    const assistantMessage = await database.sessions.appendMessage(
      sessionId,
      'assistant',
      assistantText,
      { responseId },
    )
    if (mode === 'plan') {
      const content = buildPlanArtifactContent(userInput, assistantText)
      const plan = await database.plans.upsertActive(
        sessionId,
        content.title,
        content.summary,
        content.steps,
        assistantMessage.id,
      )
      yield {
        type: 'plan_artifact',
        action: 'created',
        plan,
        session_id: sessionId,
      }
      await database.auditLog.record(sessionId, 'plan_checkpointed', {
        planId: plan.id,
        sourceMessageId: assistantMessage.id,
      })
    }
  }
  await database.auditLog.record(sessionId, 'turn_completed', {
    responseId,
    assistantBytes: Buffer.byteLength(assistantText, 'utf8'),
  })
  yield {
    type: 'response_completed',
    response_id: responseId,
    session_id: sessionId,
  }
}

/**
 * 确保会话存在并设为当前模式（移植 _ensure_session，runtime.py:194-212）。
 * 已存在则 update_mode 后回读；否则 create_session(title="Kodeks session", ...)。
 */
async function ensureSession(
  database: KodeksDatabase,
  requestedSessionId: string | null,
  mode: string,
  workspaceRoot: string,
  parentSessionId: string | null,
): Promise<{ id: string }> {
  if (requestedSessionId) {
    const existing = await database.sessions.getSession(requestedSessionId)
    if (existing !== null) {
      await database.sessions.updateMode(requestedSessionId, mode)
      return (await database.sessions.getSession(requestedSessionId)) ?? existing
    }
  }
  return database.sessions.createSession(
    'Kodeks session',
    mode,
    workspaceRoot,
    requestedSessionId,
    parentSessionId,
  )
}

/** 构建一个运行时 error 事件（移植 _error_event，runtime.py:215-223）。 */
function errorEvent(message: string, sessionId: string, code = 'runtime_error'): RuntimeEvent {
  return {
    type: 'error',
    message,
    code,
    session_id: sessionId,
  }
}

/**
 * 复刻 Python `_string`（runtime.py:226-227）：仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 null。
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * 读取可选父会话 id 以支持轻量会话 fork（移植 _parent_session_id，runtime.py:230-233）。
 * camelCase parentSessionId 优先，其次 snake_case parent_session_id。
 */
function parentSessionIdOf(body: Record<string, unknown>): string | null {
  return stringOrNull(body.parentSessionId) || stringOrNull(body.parent_session_id)
}

/** 把未知异常转成消息字符串（对应 Python str(exc)）。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

// createDatabase 在此重导出方便测试/调用方按需异步建库（与 M2 一致，不改其行为）。
export { createDatabase }
