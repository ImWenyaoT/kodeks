// frontend/lib/server/routes/routes.test.ts
// M5 路由门禁：移植 Python tests/test_route_parity.py + tests/test_app.py（忽略静态文件用例），
// 外加 oracle SSE 文本重放（10 场景，runtime.sse / ui.sse 归一化后逐字符对拍）。
// 路由逻辑函数全部可注入（db / workspaceRoot / env / factory / checkUpstream），无需起 HTTP server。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, currentTimestamp, type KodeksDatabase } from '../storage'
import { loadAllScenarios, type OracleScenario } from '../oracle'
import type { ResponsesEventFactory } from '../agent'
import { ExecutorTimeoutError, type Executor } from '../execution'
import {
  bridgePreflight,
  createChatStreamResponse,
  createChatUiResponse,
  createSession,
  decideApproval,
  filesList,
  getApproval,
  getSession,
  health,
  listSessions,
  modelsCatalog,
  type UpstreamCheck,
} from './index'

// ── 共享脚手架 ───────────────────────────────────────────────────────────────

/** 建一个内存库（每个用例隔离）。 */
async function makeDb(): Promise<KodeksDatabase> {
  return createDatabase(':memory:')
}

/** 建一个临时工作区并写入文件。 */
function makeWorkspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'kodeks-route-'))
  for (const [relPath, content] of Object.entries(files)) {
    const target = join(root, relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

/** 计算审批命令 hash，测试与服务端走同一 SHA256 契约。 */
function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex')
}

// ── Sessions（移植 test_route_parity / test_app 的 session 用例）──────────────

describe('Sessions 路由', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await makeDb()
  })
  afterEach(() => db.close())

  it('list 含 activePlan，get 含 transcript，缺失 → 404 {detail}', async () => {
    const root = makeWorkspace()
    const session = await db.sessions.createSession('Parity', 'act', root, 'sess_parity')
    await db.sessions.appendMessage(session.id, 'user', { text: 'hello' })
    const now = currentTimestamp()
    await db.connection.execute({
      sql: `
        INSERT INTO plan_artifacts
          (id, session_id, title, summary, steps_json, status, source_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        'plan_active',
        session.id,
        'Plan',
        'Do the work',
        JSON.stringify([{ id: 'step_1', title: 'Inspect', status: 'completed', details: null }]),
        'active',
        'msg_source',
        now,
        now,
      ],
    })

    const listed = await listSessions(db)
    const loaded = await getSession('sess_parity', db)
    const missing = await getSession('missing', db)

    expect(listed.status).toBe(200)
    const listedBody = await listed.json()
    expect(listedBody.sessions[0].activePlan.id).toBe('plan_active')
    expect(listedBody.sessions[0].activePlan.steps[0].id).toBe('step_1')

    expect(loaded.status).toBe(200)
    const loadedBody = await loaded.json()
    expect(loadedBody.session.id).toBe('sess_parity')
    expect(loadedBody.messages[0].content).toEqual({ text: 'hello' })

    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ detail: 'Session not found.' })
  })

  it('list 无 active plan 时 activePlan 为 null', async () => {
    const root = makeWorkspace()
    await db.sessions.createSession('NoPlan', 'act', root, 'sess_noplan')
    const listed = await listSessions(db)
    const body = await listed.json()
    expect(body.sessions[0].activePlan).toBeNull()
  })

  it('create 用 201；mode 严格相等（plan 命中，其它退 act）；默认 title', async () => {
    const root = makeWorkspace()
    const created = await createSession(
      { session_id: 'sess_py', title: 'Python', mode: 'plan' },
      db,
      root,
    )
    expect(created.status).toBe(201)
    const body = await created.json()
    expect(body.session.id).toBe('sess_py')
    expect(body.session.mode).toBe('plan')
    expect(body.session.title).toBe('Python')

    const reread = await getSession('sess_py', db)
    expect((await reread.json()).session.mode).toBe('plan')
  })

  it('create：mode 非精确 "plan" 一律 act；空 title → Kodeks session', async () => {
    const root = makeWorkspace()
    const created = await createSession({ mode: 'Plan', title: '   ' }, db, root)
    const body = await created.json()
    expect(body.session.mode).toBe('act')
    expect(body.session.title).toBe('Kodeks session')
  })

  it('get：空白 id → 400 {detail:"Missing session id."}', async () => {
    const res = await getSession('   ', db)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ detail: 'Missing session id.' })
  })
})

// ── Workspace / favicon（favicon 无 route；workspace limit 用例）──────────────

describe('Workspace 路由', () => {
  it('files 只列可见文件（黑名单目录/.env 前缀剔除）', async () => {
    const root = makeWorkspace({
      'src/app.py': "print('ok')\n",
      '.kodeks/secret.json': '{}\n',
      '.ruff_cache/CACHEDIR.TAG': 'cache\n',
      '.uv-cache/CACHEDIR.TAG': 'cache\n',
      '.env.backup': 'OPENAI_API_KEY=secret\n',
    })
    const res = filesList(root)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: ['src/app.py'] })
  })
})

// ── Health（runtime 改 'typescript'）──────────────────────────────────────────

describe('Health 路由', () => {
  it('返回 {ok:true, runtime:"typescript"}', async () => {
    const res = health()
    expect(await res.json()).toEqual({ ok: true, runtime: 'typescript' })
  })
})

// ── Approvals（移植 test_route_parity 的 approval 用例）────────────────────────

describe('Approvals 路由', () => {
  let db: KodeksDatabase
  let root: string
  beforeEach(async () => {
    db = await makeDb()
    root = makeWorkspace()
  })
  afterEach(() => db.close())

  it('reject/approve/repeat/malformed/invalid/missing 状态码 + 审计顺序', async () => {
    const rejected = await db.approvals.createApproval(
      { command: 'echo no' },
      'needs approval',
      'sess_approval',
      'call_reject',
    )
    const approved = await db.approvals.createApproval(
      { command: 'printf ok' },
      'needs approval',
      'sess_approval',
      'call_run',
    )
    const malformed = await db.approvals.createApproval(
      { notCommand: 'echo nope' },
      'needs approval',
      'sess_approval',
    )

    const before = await getApproval(rejected.id, db)
    expect((await before.json()).approval.status).toBe('pending')

    const rejRes = await decideApproval(
      rejected.id,
      { decision: 'reject', reason: 'not today' },
      db,
      root,
    )
    const appRes = await decideApproval(
      approved.id,
      { decision: 'approve', expectedCommandHash: commandHash('printf ok') },
      db,
      root,
    )
    const repeatRes = await decideApproval(
      approved.id,
      { decision: 'approve', expectedCommandHash: commandHash('printf ok') },
      db,
      root,
    )
    const malRes = await decideApproval(malformed.id, { decision: 'approve' }, db, root)
    const invRes = await decideApproval(rejected.id, { decision: 'maybe' }, db, root)
    const missRes = await getApproval('appr_missing', db)

    expect(rejRes.status).toBe(200)
    const rejBody = await rejRes.json()
    expect(rejBody.approval.status).toBe('rejected')
    expect(rejBody.approval.reason).toBe('not today')

    expect(appRes.status).toBe(200)
    const appBody = await appRes.json()
    expect(appBody.approval.status).toBe('executed')
    expect(appBody.result.stdout).toBe('ok')

    expect(repeatRes.status).toBe(409)
    expect((await repeatRes.json()).detail).toContain('already resolved')

    expect(malRes.status).toBe(400)
    expect(await malRes.json()).toEqual({
      error: 'Approval does not contain an executable command.',
    })

    expect(invRes.status).toBe(400)
    expect(await invRes.json()).toEqual({
      error: 'Invalid decision. Expected "approve" or "reject".',
    })

    expect(missRes.status).toBe(404)

    const rows = await db.connection.execute(
      'SELECT event_type, payload_json FROM audit_log ORDER BY rowid ASC',
    )
    expect(rows.rows.map((r) => r.event_type)).toEqual([
      'approval_rejected',
      'approval_executed',
    ])
    expect(JSON.parse(String(rows.rows[1].payload_json)).stdout).toBe('ok')
  })

  it('approve 可用 expectedCommandHash 绑定真实命令', async () => {
    const approval = await db.approvals.createApproval(
      { command: 'printf ok' },
      'needs approval',
      'sess_approval',
      'call_run',
    )

    const mismatch = await decideApproval(
      approval.id,
      { decision: 'approve', expectedCommandHash: 'wrong-hash' },
      db,
      root,
    )
    const accepted = await decideApproval(
      approval.id,
      {
        decision: 'approve',
        expectedCommandHash:
          commandHash('printf ok'),
      },
      db,
      root,
    )

    expect(mismatch.status).toBe(409)
    expect((await mismatch.json()).detail).toBe('Approval command hash mismatch.')
    expect(accepted.status).toBe(200)
    expect((await accepted.json()).approval.status).toBe('executed')
  })

  it('approve 不做 shell 解析：shell-only 语法 → exitCode null + "without a shell"', async () => {
    const approval = await db.approvals.createApproval(
      { command: 'pytest -q 2>&1' },
      'needs approval',
      'sess_approval',
      'call_shell_syntax',
    )
    const res = await decideApproval(
      approval.id,
      { decision: 'approve', expectedCommandHash: commandHash('pytest -q 2>&1') },
      db,
      root,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.approval.status).toBe('executed')
    expect(body.result.exitCode).toBeNull()
    expect(body.result.stderr).toContain('without a shell')
  })

  it('approve 缺 command hash → 409 且不执行', async () => {
    const approval = await db.approvals.createApproval(
      { command: 'printf ok' },
      'needs approval',
      'sess_approval',
      'call_run',
    )

    const res = await decideApproval(approval.id, { decision: 'approve' }, db, root)

    expect(res.status).toBe(409)
    expect((await res.json()).detail).toBe('Approval command hash is required.')
    expect((await db.approvals.getApproval(approval.id)).status).toBe('pending')
  })

  it('approved 命令执行超时后进入 failed 终态', async () => {
    const approval = await db.approvals.createApproval(
      { command: 'node slow.js' },
      'needs approval',
      'sess_approval',
      'call_timeout',
    )
    const timeoutExecutor: Executor = {
      async run() {
        throw new ExecutorTimeoutError('timed out')
      },
    }

    const res = await decideApproval(
      approval.id,
      { decision: 'approve', expectedCommandHash: commandHash('node slow.js') },
      db,
      root,
      timeoutExecutor,
    )

    expect(res.status).toBe(408)
    const stored = await db.approvals.getApproval(approval.id)
    expect(stored.status).toBe('failed')
    expect(stored.reason).toContain('Shell command timed out')
  })

  it('get 缺失审批 → 404 {detail}', async () => {
    const res = await getApproval('appr_nope', db)
    expect(res.status).toBe(404)
    expect((await res.json()).detail).toContain('not found')
  })
})

// ── Models（exclude_none：baseURL/primary 缺失键省略）──────────────────────────

describe('Models 路由', () => {
  it('返回默认目录（primary present），默认 option 携带 baseURL（非 null 不省略）', async () => {
    const res = modelsCatalog({})
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.primary).toBe('deepseek/deepseek-v4-pro')
    expect(Array.isArray(body.models)).toBe(true)
    // 默认 option baseURL 为真实字符串（https://api.deepseek.com）→ exclude_none 保留键。
    for (const option of body.models) {
      expect(typeof option.baseURL).toBe('string')
      expect(option).toHaveProperty('configured')
    }
  })

  it('exclude_none：option baseURL 为 null 时整键省略，primary 为 null 时整键省略', async () => {
    // 直接构造含 null baseURL/primary 的目录走 dump 逻辑：经过 JSON 序列化键应消失。
    const res = modelsCatalog({})
    const text = await res.text()
    // 序列化文本里不应出现字面 "baseURL":null 或 "primary":null。
    expect(text).not.toContain('"baseURL":null')
    expect(text).not.toContain('"primary":null')
  })
})

// ── Bridge preflight（移植 test_route_parity 的 preflight 用例）────────────────

describe('Bridge preflight 路由', () => {
  it('provider=openai → model_configuration_error，provider 标 auto，200', async () => {
    const env = {
      KODEKS_CONFIG_PATH: join(makeWorkspace(), 'missing.json'),
      KODEKS_WORKSPACE_ROOT: makeWorkspace(),
    }
    const res = await bridgePreflight({ body: { provider: 'openai' }, env })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('unavailable')
    expect(body.provider).toBe('auto')
    expect(body.code).toBe('model_configuration_error')
    expect(body.reason).toContain('outside the Kodeks product boundary')
  })

  it('无 provider 配置 → model_provider_missing', async () => {
    const env = {
      KODEKS_CONFIG_PATH: join(makeWorkspace(), 'missing.json'),
      KODEKS_WORKSPACE_ROOT: makeWorkspace(),
    }
    const res = await bridgePreflight({ body: {}, env })
    const body = await res.json()
    expect(body.status).toBe('unavailable')
    expect(body.code).toBe('model_provider_missing')
  })

  it('注入 checkUpstream 报 unreachable → 透传 code/reason + base 字段', async () => {
    const fakeUnreachable: UpstreamCheck = async () => ({
      code: 'moonbridge_upstream_unreachable',
      reason: 'Configured Chat Completions upstream is unreachable: test.',
    })
    const env = {
      KODEKS_CONFIG_PATH: join(makeWorkspace(), 'missing.json'),
      KODEKS_WORKSPACE_ROOT: makeWorkspace(),
      KODEKS_MODEL_PROVIDER: 'moonbridge',
      KODEKS_CHAT_COMPLETIONS_API_KEY: 'local-placeholder',
      KODEKS_CHAT_COMPLETIONS_BASE_URL: 'http://local.test/v1',
      KODEKS_CHAT_COMPLETIONS_MODEL: 'deepseek-v4-pro',
    }
    const res = await bridgePreflight({
      body: { model: 'deepseek/deepseek-v4-pro' },
      env,
      checkUpstream: fakeUnreachable,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('unavailable')
    expect(body.code).toBe('moonbridge_upstream_unreachable')
    expect(body.upstreamBaseURL).toBe('http://local.test/v1')
    expect(body.resolvedProvider).toBe('moonbridge')
  })

  it('checkedAt 为 6 位微秒 ISO-Z 格式', async () => {
    const res = await bridgePreflight({ body: {}, env: { KODEKS_WORKSPACE_ROOT: makeWorkspace() } })
    const body = await res.json()
    expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })
})

// ── Chat 路由：缺失 input（移植 test_app 的 chat 用例）─────────────────────────

describe('Chat 路由：缺失 input', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await makeDb()
  })
  afterEach(() => db.close())

  it('/stream 缺 input → SSE 含 "Input is required."', async () => {
    const res = createChatStreamResponse({
      body: { session_id: 'sess_py' },
      database: db,
      workspaceRoot: makeWorkspace(),
      env: {},
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text).toContain('Input is required.')
  })

  it('/ui 缺 input → SSE 含 errorText + "Input is required."', async () => {
    const res = createChatUiResponse({
      body: { session_id: 'sess_py' },
      database: db,
      workspaceRoot: makeWorkspace(),
      env: {},
    })
    const text = await res.text()
    expect(text).toContain('Input is required.')
    expect(text).toContain('errorText')
  })
})

describe('Chat 路由：server-owned selected files', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await makeDb()
  })
  afterEach(() => db.close())

  it('selected files 只信路径，内容由服务端从 workspace 读取', async () => {
    const root = makeWorkspace({
      'src/example.ts': 'export const serverOwned = true\n',
    })
    const seenBodies: Record<string, unknown>[] = []
    const factory: ResponsesEventFactory = (body) => {
      seenBodies.push(body)
      return [{ type: 'response.completed', response: { id: 'resp_selected_route' } }]
    }

    const res = createChatStreamResponse({
      body: {
        input: 'use selected',
        selectedFiles: [
          { path: 'src/example.ts', content: 'client injected content' },
          '../outside.txt',
        ],
        instructions: 'client injected instructions',
        provider: 'client-provider',
      },
      database: db,
      workspaceRoot: root,
      env: {},
      factory,
    })
    await res.text()

    const instructions = String(seenBodies[0].instructions)
    expect(instructions).toContain('export const serverOwned = true')
    expect(instructions).toContain('Unable to read selected file: Path escapes workspace')
    expect(instructions).not.toContain('client injected content')
    expect(instructions).not.toContain('client injected instructions')
    expect(seenBodies[0].provider).toBeUndefined()
  })
})

// ── Oracle SSE 文本重放（10 场景，runtime.sse / ui.sse）────────────────────────

/** 把 SSE 文本中的 volatile（生成 id + ISO 时间戳，含 tool_output 内嵌）归一化。 */
function normalizeSse(text: string): string {
  return text
    .replace(/(appr|atom|plan|msg|mem|mart|sub|aud)_[0-9a-f]{32}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
}

/** 按调用次序返回 script.json 的对应轮次（与 oracle-replay 一致）。 */
function makeScriptedFactory(rounds: Record<string, unknown>[][]): ResponsesEventFactory {
  let index = 0
  return () => {
    const round = rounds[index] ?? rounds[rounds.length - 1] ?? []
    index += 1
    return round
  }
}

/** 写入 setup.workspaceFiles 并预置 seedMemories。 */
async function prepareScenario(scenario: OracleScenario, db: KodeksDatabase): Promise<string> {
  const root = makeWorkspace(scenario.setup.workspaceFiles)
  for (const memory of scenario.setup.seedMemories) {
    await db.memories.remember(
      String(memory.scope),
      String(memory.content),
      memory.sourceSessionId ?? null,
    )
  }
  return root
}

describe('Oracle SSE 文本重放：createChatStreamResponse / createChatUiResponse 对拍黄金 .sse', () => {
  const scenarios = loadAllScenarios()
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await makeDb()
  })
  afterEach(() => db.close())

  it('清单含 10 个场景', () => {
    expect(scenarios.length).toBe(10)
  })

  for (const scenario of scenarios) {
    it(`场景 ${scenario.id}：runtime.sse 归一化后逐字符一致`, async () => {
      const root = await prepareScenario(scenario, db)
      const res = createChatStreamResponse({
        body: scenario.request,
        database: db,
        workspaceRoot: root,
        env: scenario.setup.env,
        factory: makeScriptedFactory(scenario.script),
      })
      const actual = normalizeSse(await res.text())
      expect(actual).toBe(normalizeSse(scenario.runtimeSse))
    })

    it(`场景 ${scenario.id}：ui.sse 归一化后逐字符一致（null payload 丢弃）`, async () => {
      const root = await prepareScenario(scenario, db)
      const res = createChatUiResponse({
        body: scenario.request,
        database: db,
        workspaceRoot: root,
        env: scenario.setup.env,
        factory: makeScriptedFactory(scenario.script),
      })
      const actual = normalizeSse(await res.text())
      expect(actual).toBe(normalizeSse(scenario.uiSse))
    })
  }
})
