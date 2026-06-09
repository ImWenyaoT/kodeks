// frontend/lib/server/agent/runtime.test.ts
// 移植自 Python tests/test_runtime.py（scripted-model 用例）：逐字断言事件序列 / 指令字符串 /
// transcript 形状 / 审计序列 / approval / plan / memory / selected files / bridge adapter 路由。
// 全部用 :memory: libSQL（异步 createDatabase）+ 临时 workspace；注入 scripted 工厂或 stub fetch。
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabase, type KodeksDatabase } from '../storage'
import { buildPlanArtifactContent } from '../plans'
import { runPythonChatTurn } from './runtime'
import type { ResponsesEventFactory } from './responses-runtime'

/** 创建一个临时工作区目录。 */
function makeWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'kodeks-runtime-'))
}

/** 判断 replay body 是否已含工具输出项（区分第一轮 vs 工具结果后那一轮）。 */
function hasFunctionCallOutput(body: Record<string, unknown>): boolean {
  const replayInput = body.input
  return (
    Array.isArray(replayInput) &&
    replayInput.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'function_call_output',
    )
  )
}

/** 第一轮请求 read_file，第二轮拿到工具输出后给最终答复（移植 _responses_events）。 */
const responsesEvents: ResponsesEventFactory = (body) => {
  if (hasFunctionCallOutput(body)) {
    return [
      { type: 'response.output_text.delta', delta: 'Done.' },
      { type: 'response.completed', response: { id: 'resp_final', status: 'completed' } },
    ]
  }
  return [
    { type: 'response.output_text.delta', delta: 'Reading...' },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
      },
    },
    { type: 'response.completed', response: { id: 'resp_tool', status: 'completed' } },
  ]
}

/** 请求一个危险 shell 命令以验证本地暂停（移植 _approval_events）。 */
const approvalEvents: ResponsesEventFactory = () => [
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'call_shell',
      name: 'run_shell',
      arguments: JSON.stringify({ command: 'rm -rf output' }),
    },
  },
  { type: 'response.completed', response: { id: 'resp_approval', status: 'completed' } },
]

/** 请求读大文件，工具输出 artifact replay 后收尾（移植 _large_tool_events）。 */
const largeToolEvents: ResponsesEventFactory = (body) => {
  if (hasFunctionCallOutput(body)) {
    return [{ type: 'response.completed', response: { id: 'resp_large', status: 'completed' } }]
  }
  return [
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_large',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'large.txt' }),
      },
    },
    { type: 'response.completed', response: { id: 'resp_large', status: 'completed' } },
  ]
}

/** 请求一个未注册工具以验证本地运行时硬停（移植 _unknown_tool_events）。 */
const unknownToolEvents: ResponsesEventFactory = () => [
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: 'call_glob',
      name: 'glob',
      arguments: JSON.stringify({ pattern: '**/*.ts' }),
    },
  },
  { type: 'response.completed', response: { id: 'resp_unknown', status: 'completed' } },
]

/** 模型流直接发 error 事件（移植 _stream_error_events）。 */
const streamErrorEvents: ResponsesEventFactory = () => [
  { type: 'error', message: 'upstream stream error' },
]

/** 捕获运行时 body 同时返回已完成的模型 turn（移植 _capture_only_events）。 */
function captureOnlyEvents(captured: Record<string, unknown>[]): ResponsesEventFactory {
  return (body) => {
    captured.push(body)
    return [{ type: 'response.completed', response: { id: 'resp_capture' } }]
  }
}

/** plan 模式单轮文本（移植 _plan_events）。 */
const planEvents: ResponsesEventFactory = () => [
  {
    type: 'response.output_text.delta',
    delta: '# Storage plan\n\nPersist a plan artifact.\n\n1. Add a plans table\n2. Restore it next turn',
  },
  { type: 'response.completed', response: { id: 'resp_plan', status: 'completed' } },
]

/** 收集一个 chat turn 的全部运行时事件。 */
async function collect(
  body: Record<string, unknown>,
  db: KodeksDatabase,
  root: string,
  env: Record<string, string | null> | null,
  factory: ResponsesEventFactory | null,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  for await (const event of runPythonChatTurn(body, db, root, env, factory)) {
    events.push(event as Record<string, unknown>)
  }
  return events
}

describe('Python chat 循环（移植 tests/test_runtime.py 的 scripted-model 用例）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('注入的 Responses 事件驱动循环流式文本+工具并持久化会话（test_..._streams_text_tools_and_persists_session）', async () => {
    const root = makeWorkspaceDir()
    writeFileSync(join(root, 'README.md'), 'hello from workspace\n')
    const events = await collect(
      { input: 'read it', session_id: 'sess_py' },
      db,
      root,
      {},
      responsesEvents,
    )

    expect(events.map((e) => e.type)).toEqual([
      'session_created',
      'text_delta',
      'assistant_status',
      'tool_call',
      'tool_result',
      'text_delta',
      'response_completed',
    ])
    expect(events[3].tool_name).toBe('read_file')
    expect(events[4].tool_status).toBe('ok')
    expect(events[5].delta).toBe('Done.')
    expect(String(events[4].tool_output)).toContain('hello from workspace')
    expect(await db.sessions.getSession('sess_py')).not.toBeNull()

    const transcript = await db.sessions.getTranscript('sess_py')
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect((transcript[1].content as { text: string }).text).toBe('Reading...')
    expect((transcript[1].content as { toolCalls: unknown }).toolCalls).toEqual([
      { id: 'call_read', name: 'read_file', args: { path: 'README.md' } },
    ])
    expect(transcript[2].role).toBe('tool')
    expect((transcript[2].content as { toolCallId: string }).toolCallId).toBe('call_read')
    expect(String((transcript[2].content as { text: string }).text)).toContain('hello from workspace')
    expect(transcript[3].content).toBe('Done.')

    const audit = await db.connection.execute(
      'SELECT event_type FROM audit_log ORDER BY rowid ASC',
    )
    expect(audit.rows.map((r) => r.event_type)).toEqual([
      'turn_started',
      'harness_pattern_selected',
      'tool_called',
      'tool_result',
      'turn_completed',
    ])
  })

  it('新会话可记录其父会话 id（test_..._records_session_fork_parent）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'try a different plan', session_id: 'sess_fork', parentSessionId: 'sess_parent' },
      db,
      root,
      {},
      captureOnlyEvents([]),
    )

    const session = await db.sessions.getSession('sess_fork')
    expect(events[0]).toEqual({ type: 'session_created', session_id: 'sess_fork' })
    expect(session).not.toBeNull()
    expect(session?.parentSessionId).toBe('sess_parent')
  })

  it('拒绝直连 Responses provider（test_..._rejects_direct_responses_provider）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'hello', session_id: 'sess_direct' },
      db,
      root,
      { KODEKS_MODEL_PROVIDER: 'openai' },
      null,
    )

    expect(events.map((e) => e.type)).toEqual(['session_created', 'error'])
    expect(events[1].code).toBe('model_configuration_error')
    expect(String(events[1].message)).toContain('outside the Kodeks product boundary')
  })

  it('Chat Completions 模型经桥适配器路由（test_..._routes_chat_completions_through_bridge_adapter）', async () => {
    const root = makeWorkspaceDir()
    // stub 全局 fetch：断言上游请求并返回最小 Chat Completions SSE 流（替代 Python monkeypatch fetch_chat_completions_stream）。
    const sseBody =
      'data: ' +
      JSON.stringify({
        id: 'chatcmpl_test',
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: { content: 'Bridge' }, finish_reason: null }],
      }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({
        id: 'chatcmpl_test',
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      '\n\n' +
      'data: [DONE]\n\n'
    const fetchSpy = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const payload = JSON.parse(init.body) as { model: string }
      // 上游 payload 的 model 为上游配置 model（deepseek-v4-pro）。
      expect(payload.model).toBe('deepseek-v4-pro')
      // Authorization 头携带解析出的 api key。
      expect(init.headers.Authorization).toBe('Bearer local-placeholder')
      // 上游 URL 由 base url 拼接。
      expect(url).toBe('https://api.deepseek.com/chat/completions')
      return new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    const original = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const events = await collect(
        { input: 'hello', session_id: 'sess_bridge', model: 'deepseek/deepseek-v4-pro' },
        db,
        root,
        {
          KODEKS_MODEL_PROVIDER: 'moonbridge',
          KODEKS_CHAT_COMPLETIONS_API_KEY: 'local-placeholder',
          KODEKS_CHAT_COMPLETIONS_BASE_URL: 'https://api.deepseek.com',
          KODEKS_CHAT_COMPLETIONS_MODEL: 'deepseek-v4-pro',
        },
        null,
      )
      expect(events.map((e) => e.type)).toEqual(['session_created', 'text_delta', 'response_completed'])
      expect(events[1].delta).toBe('Bridge')
    } finally {
      globalThis.fetch = original
    }
  })

  it('持久化的工具调用与输出被 replay 为 Responses 输入项（test_..._replays_tool_continuation_input）', async () => {
    const root = makeWorkspaceDir()
    writeFileSync(join(root, 'README.md'), 'hello from workspace\n')
    const captured: Record<string, unknown>[] = []
    await collect({ input: 'read it', session_id: 'sess_replay' }, db, root, {}, responsesEvents)
    await collect(
      { input: 'continue', session_id: 'sess_replay' },
      db,
      root,
      {},
      captureOnlyEvents(captured),
    )

    const replayInput = captured[0].input as Record<string, unknown>[]
    expect(replayInput[0].role).toBe('user')
    expect(replayInput[1].role).toBe('assistant')
    expect(replayInput[1].content).toEqual([
      { type: 'output_text', text: 'Reading...', annotations: [] },
    ])
    expect(replayInput[2].type).toBe('function_call')
    expect(replayInput[2].call_id).toBe('call_read')
    expect(replayInput[2].arguments).toBe('{"path":"README.md"}')
    expect(replayInput[3].type).toBe('function_call_output')
    expect(replayInput[3].call_id).toBe('call_read')
    expect(String(replayInput[3].output)).toContain('hello from workspace')
    expect(replayInput[4].role).toBe('assistant')
    expect(replayInput[4].content).toEqual([
      { type: 'output_text', text: 'Done.', annotations: [] },
    ])
    const last = replayInput[replayInput.length - 1]
    expect(last.role).toBe('user')
    expect((last.content as { text: string }[])[0].text).toBe('continue')
  })

  it('未知工具在本地停止（test_..._stops_unknown_tool_locally）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'find files', session_id: 'sess_unknown' },
      db,
      root,
      {},
      unknownToolEvents,
    )

    expect(events.map((e) => e.type)).toEqual([
      'session_created',
      'assistant_status',
      'tool_call',
      'tool_result',
      'error',
    ])
    expect(events[3].tool_status).toBe('error')
    expect(events[3].tool_output).toBe('Unknown tool requested by model: glob')
    expect(events[4].code).toBe('model_requested_unknown_tool')
    const transcript = await db.sessions.getTranscript('sess_unknown')
    expect(transcript.map((m) => m.role)).toEqual(['user'])
  })

  it('Responses error 事件映射为终止性 runtime 错误（test_..._maps_responses_error_events）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'hello', session_id: 'sess_error' },
      db,
      root,
      {},
      streamErrorEvents,
    )

    expect(events).toEqual([
      { type: 'session_created', session_id: 'sess_error' },
      {
        type: 'error',
        message: 'upstream stream error',
        code: 'runtime_error',
        session_id: 'sess_error',
      },
    ])
  })

  it('大工具输出被卸载为 memory artifact 引用（test_..._offloads_large_tool_outputs）', async () => {
    const root = makeWorkspaceDir()
    writeFileSync(join(root, 'large.txt'), 'memory artifact body '.repeat(80))
    const events = await collect(
      { input: 'read the large file', session_id: 'sess_large' },
      db,
      root,
      { KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES: '64' },
      largeToolEvents,
    )

    const toolEvent = events.find((e) => e.type === 'tool_result') as Record<string, unknown>
    const output = JSON.parse(String(toolEvent.tool_output)) as { refId: string; offloaded: boolean; toolName: string }
    const artifact = await db.memories.readArtifactContent(output.refId)

    expect(output.offloaded).toBe(true)
    expect(output.toolName).toBe('read_file')
    expect(String(toolEvent.tool_output).length).toBeLessThan(1000)
    expect(artifact).not.toBeNull()
    expect(artifact?.content).toContain('memory artifact body')
  })

  it('plan 模式 assistant 文本变为持久 plan artifact 事件（test_..._creates_plan_artifact_in_plan_mode）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'make a plan for plan artifacts', session_id: 'sess_plan', mode: 'plan' },
      db,
      root,
      {},
      planEvents,
    )

    const planEvent = events.find((e) => e.type === 'plan_artifact') as Record<string, unknown>
    const activePlan = await db.plans.getActiveBySession('sess_plan')
    const plan = planEvent.plan as { title: string; summary: string; steps: unknown }

    expect(planEvent.action).toBe('created')
    expect(plan.title).toBe('Storage plan')
    expect(plan.summary).toBe('Persist a plan artifact.')
    expect(plan.steps).toEqual([
      { id: 'step_1', title: 'Add a plans table', status: 'pending', details: null },
      { id: 'step_2', title: 'Restore it next turn', status: 'pending', details: null },
    ])
    expect(activePlan).not.toBeNull()
    expect(activePlan?.title).toBe('Storage plan')
    expect(events.map((e) => e.type).slice(-2)).toEqual(['plan_artifact', 'response_completed'])
  })

  it('已存在的 active plan 被恢复并注入模型指令（test_..._recovers_active_plan_into_runtime_context）', async () => {
    const root = makeWorkspaceDir()
    const seenBodies: Record<string, unknown>[] = []
    const factory: ResponsesEventFactory = (body) => {
      seenBodies.push(body)
      return [{ type: 'response.completed', response: { id: 'resp_resume' } }]
    }
    await db.sessions.createSession('Plan session', 'act', root, 'sess_resume')
    await db.plans.upsertActive(
      'sess_resume',
      'Recovered plan',
      'Keep the next turn aligned with the stored plan.',
      [{ id: 'step_1', title: 'Use the active plan in context', status: 'pending', details: null }],
    )

    const events = await collect(
      { input: 'continue', session_id: 'sess_resume' },
      db,
      root,
      {},
      factory,
    )

    expect(events[1].type).toBe('plan_artifact')
    expect(events[1].action).toBe('recovered')
    expect(String(seenBodies[0].instructions)).toContain('Recovered plan')
    expect(String(seenBodies[0].instructions)).toContain('Use the active plan in context')
  })

  it('召回的记忆在模型前被注入指令（test_..._injects_recalled_memory_before_model）', async () => {
    const root = makeWorkspaceDir()
    const seenBodies: Record<string, unknown>[] = []
    const factory: ResponsesEventFactory = (body) => {
      seenBodies.push(body)
      return [{ type: 'response.completed', response: { id: 'resp_memory' } }]
    }
    await db.memories.remember('project', 'Kodeks uses plan mode for read-only planning.', 'sess_memory')

    const events = await collect(
      { input: 'how should plan mode work?', session_id: 'sess_memory' },
      db,
      root,
      {},
      factory,
    )

    const memoryEvent = events.find((e) => e.type === 'memory_recalled') as Record<string, unknown>
    expect((memoryEvent.memory_ids as string[])[0].startsWith('atom_')).toBe(true)
    expect(memoryEvent.memory_layers).toEqual({ atom: 1 })
    expect(String(seenBodies[0].instructions)).toContain('Kodeks uses plan mode')
    expect(String(seenBodies[0].instructions)).toContain('Recalled memory:')
  })

  it('选定工作区文件被加入运行时指令（test_..._injects_selected_files_before_model）', async () => {
    const root = makeWorkspaceDir()
    const seenBodies: Record<string, unknown>[] = []
    const factory: ResponsesEventFactory = (body) => {
      seenBodies.push(body)
      return [{ type: 'response.completed', response: { id: 'resp_selected' } }]
    }

    await collect(
      {
        input: 'use selected files',
        session_id: 'sess_selected',
        selectedFiles: [
          { path: 'src/example.ts', content: 'export const selectedMarker = true;', truncated: true },
          { path: 'missing.ts', error: 'File not found' },
        ],
      },
      db,
      root,
      {},
      factory,
    )

    const instructions = String(seenBodies[0].instructions)
    expect(instructions).toContain('Selected workspace files for this turn')
    expect(instructions).toContain('src/example.ts (truncated)')
    expect(instructions).toContain('selectedMarker')
    expect(instructions).toContain('missing.ts')
    expect(instructions).toContain('Unable to read selected file: File not found')
  })

  it('危险工具调用浮现 approval_required 事件并记审计（test_..._emits_approval_required）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect(
      { input: 'clean output', session_id: 'sess_py' },
      db,
      root,
      {},
      approvalEvents,
    )

    const approval = events.find((e) => e.type === 'approval_required') as Record<string, unknown>
    const toolResult = events.find((e) => e.type === 'tool_result') as Record<string, unknown>

    expect(toolResult.tool_status).toBe('approval_required')
    expect(String(approval.approval_id).startsWith('appr_')).toBe(true)
    const stored = await db.approvals.getApproval(String(approval.approval_id))
    expect(stored.status).toBe('pending')
    const count = await db.connection.execute('SELECT COUNT(*) AS c FROM audit_log')
    expect(Number(count.rows[0].c)).toBe(5)
    const transcript = await db.sessions.getTranscript('sess_py')
    expect(transcript.map((m) => m.role)).toEqual(['user'])
  })

  it('input 缺失时 emit runtime 错误（顶层入参校验）', async () => {
    const root = makeWorkspaceDir()
    const events = await collect({ session_id: 'sess_missing' }, db, root, {}, responsesEvents)
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Input is required.',
        code: 'runtime_error',
        session_id: 'sess_missing',
      },
    ])
  })

  it('build_plan_artifact_content 保持 title/summary/steps/checkbox 状态稳定（test_build_plan_artifact_content_matches_harness_parser_shape）', () => {
    const artifact = buildPlanArtifactContent(
      'fallback title',
      '# Release plan\n\nShip safely.\n\n- [x] Map current state\n- Validate parity',
    )
    expect(artifact).toEqual({
      title: 'Release plan',
      summary: 'Ship safely.',
      steps: [
        { id: 'step_1', title: 'Map current state', status: 'completed', details: null },
        { id: 'step_2', title: 'Validate parity', status: 'pending', details: null },
      ],
    })
  })
})
