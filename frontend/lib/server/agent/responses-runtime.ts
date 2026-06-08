// frontend/lib/server/agent/responses-runtime.ts
// Responses-shaped 流循环：逐字节忠实移植自 Python src/kodeks/responses_runtime.py。
// runResponsesToolLoop（N 轮驱动器）/ liveResponsesEvents（组合 M1 桥 + M0 config）/ error helpers / pseudo 检测。
//
// 保真红线（见 30-runtime-loop.md「工具循环驱动逻辑」、80-oracle §B/§D）：
//  · 每轮重建 input = buildResponsesInputFromTranscript；maxTurns=12。
//  · 流消费分支：output_text.delta→text_delta(非空)；output_item.done→handleOutputItem；
//    response.failed→error(moonbridge_upstream_failed) return；error→error return；
//    response.completed→若 toolMessages/waiting/halt 则 break，否则 pseudo 检测→complete_assistant_turn 收尾 return。
//  · 轮末决策：halt→return；waiting→return；toolMessages→append+continue；!completed→error(stream ended) return；else return。
//  · 耗尽→error("Model tool loop exceeded the maximum turn limit.")。
//  · response_id 回退 "resp_python"；pseudo 检测含 "<tool_call" 或 'type="tool_calls"'（小写）。
import {
  ModelConfigurationError,
  loadModelRuntimeEnv,
  readChatCompletionsApiKey,
  readChatCompletionsBaseUrl,
  readChatCompletionsConfig,
  resolveModelClientOptions,
  type RuntimeEnv,
} from '../config'
import {
  fetchChatCompletionsStream,
  fromDeepseekStream,
  toDeepseekChatRequest,
} from '../bridge'
import { defaultToolDefinitions } from '../tools/schemas'
import type { KodeksDatabase } from '../storage'
import {
  buildResponsesInputFromTranscript,
  type ResponsesInputItem,
} from './conversation-state'
import {
  appendToolContinuationMessages,
  handleOutputItem,
  ToolRoundState,
  type RuntimeEvent,
  type ToolRegistryLike,
} from './tool-loop'

/** 注入点产出的 Responses 事件流：同步可迭代或异步可迭代（移植 ResponsesEventStream，responses_runtime.py:30）。 */
export type ResponsesEventStream =
  | Iterable<Record<string, unknown>>
  | AsyncIterable<Record<string, unknown>>

/** 假模型/真实模型注入工厂：(body, env) → 事件流（移植 ResponsesEventFactory，responses_runtime.py:31-33）。 */
export type ResponsesEventFactory = (
  body: Record<string, unknown>,
  env: RuntimeEnv,
) => ResponsesEventStream

/** 收尾工厂：(assistantText, responseId) → 事件异步迭代（移植 CompletionEventFactory，responses_runtime.py:34）。 */
export type CompletionEventFactory = (
  assistantText: string,
  responseId: string,
) => AsyncIterable<RuntimeEvent>

/** runResponsesToolLoop 入参（命名参数，对应 Python keyword-only）。 */
export interface RunResponsesToolLoopArgs {
  body: Record<string, unknown>
  runtimeBody: Record<string, unknown>
  database: KodeksDatabase
  workspaceRoot: string
  runtimeEnv: RuntimeEnv
  sessionId: string
  registry: ToolRegistryLike
  completeAssistantTurn: CompletionEventFactory
  responsesEventFactory: ResponsesEventFactory | null
  maxToolLoopTurns: number
}

/**
 * 把 Responses-shaped 模型事件经本地工具 continuation 跑完（移植 run_responses_tool_loop，responses_runtime.py:37-151）。
 * 每轮重建 input → 调注入工厂或 liveResponsesEvents → 消费事件 → 决定继续/暂停/终止。
 */
export async function* runResponsesToolLoop(
  args: RunResponsesToolLoopArgs,
): AsyncGenerator<RuntimeEvent> {
  const {
    runtimeBody,
    database,
    workspaceRoot,
    runtimeEnv,
    sessionId,
    registry,
    completeAssistantTurn,
    responsesEventFactory,
    maxToolLoopTurns,
  } = args

  for (let turnIndex = 0; turnIndex < maxToolLoopTurns; turnIndex += 1) {
    runtimeBody.input = (await buildResponsesInputFromTranscript(
      database,
      sessionId,
    )) as ResponsesInputItem[]
    const responsesEvents =
      responsesEventFactory !== null
        ? responsesEventFactory(runtimeBody, runtimeEnv)
        : liveResponsesEvents(runtimeBody, runtimeEnv)
    let assistantText = ''
    let completed = false
    const toolState = new ToolRoundState()
    for await (const event of aiter(responsesEvents)) {
      const eventType = event.type
      if (eventType === 'response.output_text.delta') {
        const delta = String(event.delta || '')
        if (delta) {
          assistantText += delta
          yield {
            type: 'text_delta',
            delta,
            session_id: sessionId,
          }
        }
        continue
      }

      if (eventType === 'response.output_item.done') {
        for await (const toolEvent of handleOutputItem(
          event.item,
          registry,
          database,
          workspaceRoot,
          runtimeEnv,
          sessionId,
          toolState,
        )) {
          yield toolEvent
        }
        continue
      }

      if (eventType === 'response.failed') {
        yield errorEvent(responseErrorMessage(event), sessionId, 'moonbridge_upstream_failed')
        return
      }

      if (eventType === 'error') {
        yield errorEvent(streamErrorMessage(event), sessionId)
        return
      }

      if (eventType === 'response.completed') {
        completed = true
        if (
          toolState.toolMessages.length > 0 ||
          toolState.waitingForApproval ||
          toolState.haltToolLoop
        ) {
          break
        }
        if (looksLikePseudoToolCall(assistantText)) {
          yield errorEvent(
            'Model returned tool-call text instead of a native function_call event.',
            sessionId,
            'model_returned_pseudo_tool_call',
          )
          return
        }
        const response = event.response
        const responseId =
          isDict(response) && response.id !== undefined && response.id !== null
            ? String(response.id)
            : 'resp_python'
        for await (const completionEvent of completeAssistantTurn(assistantText, responseId)) {
          yield completionEvent
        }
        return
      }
    }

    if (toolState.haltToolLoop) {
      return
    }
    if (toolState.waitingForApproval) {
      return
    }
    if (toolState.toolMessages.length > 0) {
      await appendToolContinuationMessages(
        database,
        sessionId,
        assistantText,
        toolState.reasoningContent,
        toolState.toolCalls,
        toolState.toolMessages,
      )
      continue
    }
    if (!completed) {
      yield errorEvent('Model stream ended before completion.', sessionId)
      return
    }
    return
  }

  yield errorEvent('Model tool loop exceeded the maximum turn limit.', sessionId)
}

/**
 * 从已配置的模型路由生成真实 Responses-shaped 事件（移植 live_responses_events，responses_runtime.py:154-193）。
 * 仅 moonbridge provider 才继续；缺 provider/配置/api_key 抛 ModelConfigurationError。
 * 上游 request 形状（键序固定）经 toDeepseekChatRequest → fetchChatCompletionsStream → fromDeepseekStream。
 */
export async function* liveResponsesEvents(
  body: Record<string, unknown>,
  runtimeEnv: RuntimeEnv,
): AsyncGenerator<Record<string, unknown>> {
  // 解析模型 env（合并配置文件/.env，模型 ref 决定 DeepSeek 模型）。
  const modelEnv = loadModelRuntimeEnv(runtimeEnv, body.model)
  const modelOptions = resolveModelClientOptions(
    modelEnv,
    body.reasoning_effort,
    body.provider,
  )
  if (modelOptions === null) {
    throw new ModelConfigurationError(
      'An OpenAI-compatible Chat Completions provider is required. Set API_KEY or DEEPSEEK_API_KEY for the MoonBridge route.',
    )
  }
  if (modelOptions.provider !== 'moonbridge') {
    throw new ModelConfigurationError('Unsupported model provider.')
  }

  const upstream = readChatCompletionsConfig(modelEnv)
  const missing = upstream.missing
  if (Array.isArray(missing) && missing.length > 0) {
    throw new ModelConfigurationError(
      `Missing upstream Chat Completions configuration: ${missing.join(', ')}.`,
    )
  }
  const apiKey = readChatCompletionsApiKey(modelEnv)
  if (apiKey === undefined) {
    throw new ModelConfigurationError('API_KEY or DEEPSEEK_API_KEY is required.')
  }

  // request 键序逐字对齐 Python（responses_runtime.py:180-187）。
  const request: Record<string, unknown> = {
    model: body.model || modelOptions.model,
    input: body.input || '',
    instructions: body.instructions || '',
    tools: defaultToolDefinitions(body.mode === 'plan'),
    reasoning: { effort: body.reasoning_effort || 'high' },
    stream: true,
  }
  const payload = toDeepseekChatRequest(request, String(upstream.model))
  // TS 桥的 fetch 签名为 (payload, {apiKey, baseURL})；baseURL 由 config 解析（与 Python 传 model_env 等价）。
  const baseURL = readChatCompletionsBaseUrl(modelEnv)
  const stream = fetchChatCompletionsStream(payload, { apiKey, baseURL })
  for await (const event of fromDeepseekStream(stream, { model: String(request.model) })) {
    yield event
  }
}

/** 从失败的 Responses 事件读取用户可见信息（移植 _response_error_message，responses_runtime.py:196-204）。 */
function responseErrorMessage(event: Record<string, unknown>): string {
  const response = event.response
  if (isDict(response)) {
    const error = response.error
    if (isDict(error) && typeof error.message === 'string') {
      return String(error.message)
    }
  }
  return 'Model stream failed.'
}

/** 从 Responses error 流事件读取用户可见信息（移植 _stream_error_message，responses_runtime.py:207-211）。 */
function streamErrorMessage(event: Record<string, unknown>): string {
  const message = event.message
  return typeof message === 'string' && message ? String(message) : 'Model stream failed.'
}

/** 判断可见文本是否含伪造的序列化工具调用（移植 _looks_like_pseudo_tool_call，responses_runtime.py:214-218）。 */
function looksLikePseudoToolCall(text: string): boolean {
  const lowered = text.toLowerCase()
  return lowered.includes('<tool_call') || lowered.includes('type="tool_calls"')
}

/** 构建一个运行时 error 事件（移植 _error_event，responses_runtime.py:221-231）。 */
function errorEvent(message: string, sessionId: string, code = 'runtime_error'): RuntimeEvent {
  return {
    type: 'error',
    message,
    code,
    session_id: sessionId,
  }
}

/** 遍历同步或异步 Responses 事件流（移植 _aiter，responses_runtime.py:234-242）。 */
async function* aiter(stream: ResponsesEventStream): AsyncGenerator<Record<string, unknown>> {
  if (isSyncIterable(stream)) {
    for (const item of stream) {
      yield item
    }
    return
  }
  for await (const item of stream) {
    yield item
  }
}

/** 判断一个值是否同步可迭代（有 Symbol.iterator）。 */
function isSyncIterable(value: ResponsesEventStream): value is Iterable<Record<string, unknown>> {
  return typeof (value as Iterable<Record<string, unknown>>)[Symbol.iterator] === 'function'
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
