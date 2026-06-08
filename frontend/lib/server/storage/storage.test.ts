// frontend/lib/server/storage/storage.test.ts
// 存储层行为测试：移植 Python test_storage_schema_sessions_messages_and_approvals，
// 并补全覆盖全部 6 个 repository 的逐字保真行为（session/approval/plan/audit/memory/subagent + artifact 落盘）。
// 全部用 :memory: libSQL；仅测 repository 行为，不测驱动级 PRAGMA/并行（非 wire 契约）。
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  CURRENT_SCHEMA_VERSION,
  type KodeksDatabase,
  LocalFileArtifactStore,
  createDatabase,
  currentTimestamp,
  prefixedId,
  sha256Hex,
  summarizeArtifactOutput,
  utf8ByteLength,
} from './index'

describe('storage utils 保真', () => {
  it('currentTimestamp 产出 6 位微秒 ISO-Z（不是 3 位毫秒）', () => {
    const ts = currentTimestamp()
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    // toISOString 的 3 位毫秒末尾补了 000。
    expect(ts.endsWith('000Z')).toBe(true)
  })

  it('prefixedId = `${prefix}_<32位小写无连字符hex>`', () => {
    const id = prefixedId('sess')
    expect(id).toMatch(/^sess_[0-9a-f]{32}$/)
    expect(id.includes('-')).toBe(false)
  })

  it('sha256Hex / utf8ByteLength 按 UTF-8 计算', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    // 多字节字符：'你好' = 6 字节。
    expect(utf8ByteLength('你好')).toBe(6)
    expect(utf8ByteLength('abc')).toBe(3)
  })

  it('summarizeArtifactOutput：前 6 非空行单空格连接，>240 截到 239 trimEnd', () => {
    expect(summarizeArtifactOutput('shell', '  line1  \n\n  line2  ')).toBe('line1 line2')
    expect(summarizeArtifactOutput('shell', '   \n  ')).toBe('Large shell output')
    const long = 'x'.repeat(300)
    const summarized = summarizeArtifactOutput('shell', long)
    expect(summarized.length).toBe(239)
  })
})

describe('KodeksDatabase 存储 schema + 会话/消息/审批（移植 Python 门禁用例）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('schema version、会话 CRUD、transcript、审批状态机与 command_json', async () => {
    expect(await db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    const session = await db.sessions.createSession(
      'Kodeks session',
      'act',
      '/tmp/project',
      'sess_test',
    )
    await db.sessions.appendMessage(session.id, 'user', { text: 'hello' })
    const approval = await db.approvals.createApproval(
      { command: 'echo ok' },
      'Command requires approval',
      session.id,
    )

    expect(await db.sessions.getSession('sess_test')).toEqual(session)
    const transcript = await db.sessions.getTranscript('sess_test')
    expect(transcript[0].content).toEqual({ text: 'hello' })
    expect((await db.approvals.approve(approval.id)).status).toBe('approved')
    expect((await db.approvals.markExecuted(approval.id)).status).toBe('executed')
    await expect(db.approvals.markExecuted(approval.id)).rejects.toBeInstanceOf(
      ApprovalAlreadyResolvedError,
    )
    const rows = await db.connection.execute('SELECT command_json FROM approvals')
    expect(JSON.parse(String(rows.rows[0].command_json))).toEqual({ command: 'echo ok' })
  })
})

describe('SessionRepository 行为', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('createSession upsert 冲突不更新 created_at，只更新其余列', async () => {
    const first = await db.sessions.createSession('A', 'act', '/w1', 'sess_x', null)
    // 让时间戳推进。
    await new Promise((r) => setTimeout(r, 2))
    const second = await db.sessions.createSession('B', 'plan', '/w2', 'sess_x', 'parent_1')
    const stored = await db.sessions.getSession('sess_x')
    expect(stored?.title).toBe('B')
    expect(stored?.mode).toBe('plan')
    expect(stored?.workspaceRoot).toBe('/w2')
    expect(stored?.parentSessionId).toBe('parent_1')
    // created_at 保持首次值（保真风险 9）。
    expect(stored?.createdAt).toBe(first.createdAt)
    expect(stored?.updatedAt).toBe(second.updatedAt)
  })

  it('listSessions 排除已归档，按 updated_at DESC, id ASC 排序', async () => {
    // 同一时间戳下用 id ASC tiebreak：手动写两个相同 updated_at 的会话。
    const now = '2026-06-08T00:00:00.000000Z'
    await db.connection.execute({
      sql: 'INSERT INTO sessions (id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?)',
      args: ['sess_b', 't', 'act', '/w', null, now, now, null],
    })
    await db.connection.execute({
      sql: 'INSERT INTO sessions (id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?)',
      args: ['sess_a', 't', 'act', '/w', null, now, now, null],
    })
    // 已归档的不出现。
    await db.connection.execute({
      sql: 'INSERT INTO sessions (id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?)',
      args: ['sess_arch', 't', 'act', '/w', null, now, now, now],
    })
    const list = await db.sessions.listSessions()
    expect(list.map((s) => s.id)).toEqual(['sess_a', 'sess_b'])
  })

  it('appendMessage：agentEvent 为 null 写 SQL NULL；非 null 写 JSON', async () => {
    await db.sessions.createSession('t', 'act', '/w', 'sess_m')
    await db.sessions.appendMessage('sess_m', 'user', { a: 1 })
    await db.sessions.appendMessage('sess_m', 'assistant', { b: 2 }, { event: 'x' })
    const raw = await db.connection.execute(
      'SELECT agent_event_json FROM messages ORDER BY rowid ASC',
    )
    expect(raw.rows[0].agent_event_json).toBeNull()
    expect(JSON.parse(String(raw.rows[1].agent_event_json))).toEqual({ event: 'x' })
    const transcript = await db.sessions.getTranscript('sess_m')
    expect(transcript[0].agentEvent).toBeNull()
    expect(transcript[1].agentEvent).toEqual({ event: 'x' })
  })

  it('getTranscript 按 rowid ASC（插入顺序）', async () => {
    await db.sessions.createSession('t', 'act', '/w', 'sess_o')
    await db.sessions.appendMessage('sess_o', 'user', 'm1')
    await db.sessions.appendMessage('sess_o', 'assistant', 'm2')
    await db.sessions.appendMessage('sess_o', 'user', 'm3')
    const transcript = await db.sessions.getTranscript('sess_o')
    expect(transcript.map((m) => m.content)).toEqual(['m1', 'm2', 'm3'])
  })

  it('updateMode 更新 mode 与 updated_at', async () => {
    const s = await db.sessions.createSession('t', 'act', '/w', 'sess_u')
    await new Promise((r) => setTimeout(r, 2))
    await db.sessions.updateMode('sess_u', 'plan')
    const stored = await db.sessions.getSession('sess_u')
    expect(stored?.mode).toBe('plan')
    expect(stored?.updatedAt).not.toBe(s.updatedAt)
  })

  it('getSession 未找到返回 null', async () => {
    expect(await db.sessions.getSession('missing')).toBeNull()
  })
})

describe('ApprovalRepository 状态机', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('approve → 设 status/reason 都为 approved', async () => {
    const a = await db.approvals.createApproval({ c: 1 }, 'why', 's', 'tc')
    const approved = await db.approvals.approve(a.id)
    expect(approved.status).toBe('approved')
    expect(approved.reason).toBe('approved')
    expect(approved.decidedAt).not.toBeNull()
  })

  it('mark_executed 不改 reason', async () => {
    const a = await db.approvals.createApproval({ c: 1 }, 'orig reason')
    await db.approvals.approve(a.id)
    const executed = await db.approvals.markExecuted(a.id)
    expect(executed.status).toBe('executed')
    // approve 已把 reason 设为 approved；mark_executed 不再改 reason。
    expect(executed.reason).toBe('approved')
  })

  it('reject 设 status=rejected + 自定义 reason，要求 pending', async () => {
    const a = await db.approvals.createApproval({ c: 1 }, 'orig')
    const rejected = await db.approvals.reject(a.id, 'too risky')
    expect(rejected.status).toBe('rejected')
    expect(rejected.reason).toBe('too risky')
  })

  it('对非 approved 调 markExecuted 抛 ApprovalAlreadyResolvedError', async () => {
    const a = await db.approvals.createApproval({ c: 1 }, 'r')
    await expect(db.approvals.markExecuted(a.id)).rejects.toThrowError(
      `Approval already resolved: ${a.id}`,
    )
  })

  it('对非 pending 调 reject/approve 抛 ApprovalAlreadyResolvedError', async () => {
    const a = await db.approvals.createApproval({ c: 1 }, 'r')
    await db.approvals.approve(a.id)
    await expect(db.approvals.reject(a.id, 'x')).rejects.toBeInstanceOf(
      ApprovalAlreadyResolvedError,
    )
    await expect(db.approvals.approve(a.id)).rejects.toBeInstanceOf(
      ApprovalAlreadyResolvedError,
    )
  })

  it('getApproval 未找到抛 ApprovalNotFoundError（逐字消息）', async () => {
    await expect(db.approvals.getApproval('appr_missing')).rejects.toThrowError(
      'Approval not found: appr_missing',
    )
    await expect(db.approvals.getApproval('appr_missing')).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    )
  })
})

describe('PlanRepository upsert + 归档 + get_active', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('upsertActive 归档旧 active 并返回新 active；get_active 取最新', async () => {
    const steps = [{ id: 's1', title: 'step', status: 'pending' as const, details: null }]
    await db.plans.upsertActive('sess_p', 'Plan A', 'sum A', steps, 'msg_1')
    await new Promise((r) => setTimeout(r, 2))
    const planB = await db.plans.upsertActive('sess_p', 'Plan B', 'sum B', steps)
    const active = await db.plans.getActiveBySession('sess_p')
    expect(active?.id).toBe(planB.id)
    expect(active?.title).toBe('Plan B')
    expect(active?.steps).toEqual(steps)
    // 仅一条 active，旧的被归档。
    const counts = await db.connection.execute(
      "SELECT status, COUNT(*) AS n FROM plan_artifacts WHERE session_id = 'sess_p' GROUP BY status",
    )
    const byStatus = Object.fromEntries(
      counts.rows.map((r) => [String(r.status), Number(r.n)]),
    )
    expect(byStatus).toEqual({ active: 1, archived: 1 })
  })

  it('get_active 无 active 返回 null', async () => {
    expect(await db.plans.getActiveBySession('none')).toBeNull()
  })
})

describe('AuditLogRepository record', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('record 写入 payload_json + event_type + aud_ 前缀 id', async () => {
    await db.auditLog.record('sess_a', 'turn_started', { foo: 'bar' })
    const rows = await db.connection.execute('SELECT * FROM audit_log')
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]
    expect(String(row.id)).toMatch(/^aud_[0-9a-f]{32}$/)
    expect(row.event_type).toBe('turn_started')
    expect(JSON.parse(String(row.payload_json))).toEqual({ foo: 'bar' })
    expect(row.session_id).toBe('sess_a')
  })
})

describe('MemoryRepository remember/recall/recall_layered/compact/read', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('remember 双写 memories+memory_atoms，返回 mem_ id', async () => {
    const id = await db.memories.remember('global', 'remember the alpha fact', 'sess_1')
    expect(id).toMatch(/^mem_[0-9a-f]{32}$/)
    const mem = await db.connection.execute('SELECT * FROM memories')
    const atom = await db.connection.execute('SELECT * FROM memory_atoms')
    expect(mem.rows).toHaveLength(1)
    expect(atom.rows).toHaveLength(1)
    expect(mem.rows[0].confidence).toBe(1)
    expect(atom.rows[0].confidence).toBe(1)
    expect(atom.rows[0].freshness).toBe(1)
    expect(String(atom.rows[0].id)).toMatch(/^atom_[0-9a-f]{32}$/)
  })

  it('recall 按 content LIKE，updated_at DESC, rowid DESC 排序', async () => {
    await db.memories.remember('g', 'alpha one')
    await db.memories.remember('g', 'beta two')
    await db.memories.remember('g', 'alpha three')
    const hits = await db.memories.recall('alpha', 10)
    expect(hits.map((h) => h.content)).toEqual(['alpha three', 'alpha one'])
    expect(hits[0].confidence).toBe(1)
    expect(hits[0].sourceSessionId).toBeNull()
  })

  it('recallLayered：atoms 仅当 "atom"，artifacts 仅当 "artifact"；键为 atoms/artifacts', async () => {
    await db.memories.remember('g', 'atomic alpha')
    const onlyAtoms = await db.memories.recallLayered('alpha', 5, ['atom'])
    expect(onlyAtoms.atoms.length).toBe(1)
    expect(onlyAtoms.atoms[0].freshness).toBe(1)
    expect(onlyAtoms.artifacts).toEqual([])
    const none = await db.memories.recallLayered('alpha', 5, [])
    expect(none.atoms).toEqual([])
    expect(none.artifacts).toEqual([])
  })

  it('compactToolResult：<= 阈值直接返回 output（恰好阈值不落盘）', async () => {
    const output = 'x'.repeat(100)
    const result = await db.memories.compactToolResult('/ws', 'sess', 'tc', 'shell', output, 100)
    expect(result).toBe(output)
    const arts = await db.connection.execute('SELECT * FROM memory_artifacts')
    expect(arts.rows).toHaveLength(0)
  })

  it('compactToolResult：超阈值落盘 + 紧凑 JSON 返回（键顺序/常量逐字）', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kodeks-art-'))
    const localDb = await createDatabase(':memory:', {
      artifactStore: new LocalFileArtifactStore(tmp),
    })
    try {
      const output = `first line\nsecond line\n${'y'.repeat(5000)}`
      const result = await localDb.memories.compactToolResult(
        tmp,
        'sess_1',
        'tc_1',
        'shell',
        output,
        4096,
      )
      const parsed = JSON.parse(result)
      // 紧凑无空格（JSON.stringify 默认）。
      expect(result).not.toContain(', ')
      expect(result).not.toContain(': ')
      // 键顺序逐字。
      expect(Object.keys(parsed)).toEqual([
        'ok',
        'offloaded',
        'refId',
        'toolName',
        'summary',
        'byteLength',
        'message',
      ])
      expect(parsed.ok).toBe(true)
      expect(parsed.offloaded).toBe(true)
      expect(parsed.toolName).toBe('shell')
      expect(parsed.byteLength).toBe(utf8ByteLength(output))
      expect(parsed.refId).toBe(`memref_${sha256Hex(output).slice(0, 16)}`)
      expect(parsed.message).toBe(
        'Large tool output was stored as a memory artifact. Use read_memory_artifact with refId to inspect the full output.',
      )
      // 落盘文件存在且内容遵循逐字模板。
      const fileRow = await localDb.connection.execute('SELECT file_path FROM memory_artifacts')
      const filePath = String(fileRow.rows[0].file_path)
      const fileContent = await readFile(filePath, 'utf8')
      expect(fileContent.startsWith('# shell tool result\n')).toBe(true)
      expect(fileContent).toContain(`- ref: ${parsed.refId}`)
      expect(fileContent).toContain('- session: sess_1')
      expect(fileContent).toContain('- toolCall: tc_1')
      expect(fileContent).toContain('## Full Output')
    } finally {
      localDb.close()
    }
  })

  it('compactToolResult：toolCallId falsy 写 unknown', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kodeks-art-'))
    const localDb = await createDatabase(':memory:', {
      artifactStore: new LocalFileArtifactStore(tmp),
    })
    try {
      const output = 'z'.repeat(5000)
      await localDb.memories.compactToolResult(tmp, 'sess', null, 'grep', output, 4096)
      const fileRow = await localDb.connection.execute('SELECT file_path FROM memory_artifacts')
      const fileContent = await readFile(String(fileRow.rows[0].file_path), 'utf8')
      expect(fileContent).toContain('- toolCall: unknown')
    } finally {
      localDb.close()
    }
  })

  it('readArtifactContent：写后读回 {artifact, content}；ref 不存在返回 null', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kodeks-art-'))
    const localDb = await createDatabase(':memory:', {
      artifactStore: new LocalFileArtifactStore(tmp),
    })
    try {
      const output = `searched summary line\n${'w'.repeat(5000)}`
      const result = await localDb.memories.compactToolResult(
        tmp,
        'sess_1',
        'tc_1',
        'shell',
        output,
        4096,
      )
      const refId = JSON.parse(result).refId
      const read = await localDb.memories.readArtifactContent(refId)
      expect(read).not.toBeNull()
      expect(read?.artifact.refId).toBe(refId)
      expect(read?.artifact.sessionId).toBe('sess_1')
      expect(read?.artifact.toolCallId).toBe('tc_1')
      expect(read?.content).toContain('## Full Output')
      expect(await localDb.memories.readArtifactContent('memref_missing')).toBeNull()
    } finally {
      localDb.close()
    }
  })

  it('recallArtifacts 经 recallLayered 按 summary LIKE 匹配（不是 content）', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kodeks-art-'))
    const localDb = await createDatabase(':memory:', {
      artifactStore: new LocalFileArtifactStore(tmp),
    })
    try {
      // 用一个超长首行（>240）作正文起始：summary 截到 239 字符，不含末尾的 needle 关键词。
      // 这样 needle 只存在于正文（content）而不在 summary 中，用以验证按 summary 匹配。
      const head = 'unicorn keyword here ' + 'p'.repeat(300)
      const output = `${head} needleZZZ tail\n${'q'.repeat(5000)}`
      await localDb.memories.compactToolResult(tmp, 'sess', 'tc', 'shell', output, 4096)
      // summary 含首行前缀关键词 → 命中。
      const hit = await localDb.memories.recallLayered('unicorn', 5, ['artifact'])
      expect(hit.artifacts.length).toBe(1)
      expect(hit.artifacts[0].summary).toContain('unicorn')
      // needleZZZ 在 239 字符截断之外，仅存在于 content/正文 → 按 summary 匹配应搜不到。
      expect(hit.artifacts[0].summary).not.toContain('needleZZZ')
      const miss = await localDb.memories.recallLayered('needleZZZ', 5, ['artifact'])
      expect(miss.artifacts.length).toBe(0)
    } finally {
      localDb.close()
    }
  })
})

describe('SubagentRepository start/complete/get', () => {
  let db: KodeksDatabase
  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('startRun → running，completeRun → completed，getRun 回读', async () => {
    const run = await db.subagents.startRun('sess_parent', 'explorer', 'find files')
    expect(run.id).toMatch(/^sub_[0-9a-f]{32}$/)
    expect(run.status).toBe('running')
    expect(run.summary).toBeNull()
    expect(run.completedAt).toBeNull()

    const completed = await db.subagents.completeRun(run.id, 'done summary')
    expect(completed.status).toBe('completed')
    expect(completed.summary).toBe('done summary')
    expect(completed.completedAt).not.toBeNull()

    const fetched = await db.subagents.getRun(run.id)
    expect(fetched?.status).toBe('completed')
    expect(await db.subagents.getRun('sub_missing')).toBeNull()
  })

  it('completeRun 对不存在 run 抛 RuntimeError', async () => {
    await expect(db.subagents.completeRun('sub_missing', 's')).rejects.toThrowError(
      'Subagent run not found: sub_missing',
    )
  })
})
