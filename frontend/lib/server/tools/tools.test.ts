// frontend/lib/server/tools/tools.test.ts
// 工具注册表与安全子系统行为测试：移植 Python tests/test_tools.py 全 6 用例
// （registry 过滤/审批/memory/subagent/MCP），并补全 helpers 安全行为（string_argument 双行为、
// clamp_integer、failed_output 键序、json_output 紧凑、MCP 解析）。
// 全部用 :memory: libSQL（异步 createDatabase）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type KodeksDatabase, createDatabase } from '../storage'
import { WorkspaceService } from '../workspace'
import {
  clampInteger,
  failedOutput,
  jsonOutput,
  parseMcpServerManifests,
  readMcpServerManifests,
  readMemoryLayers,
  splitCsv,
  stringArgument,
} from './helpers'
import { buildDefaultToolRegistry } from './registry'
import { defaultToolDefinitions, toolDefinitionsByName } from './schemas'
import type { ToolRegistryServices } from './types'

/** 创建一个临时工作区目录。 */
function makeWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'kodeks-tools-'))
}

/** 构建服务包（workspace + db + 可选 environment）。 */
function makeServices(
  root: string,
  db: KodeksDatabase,
  environment?: Record<string, string | null | undefined>,
): ToolRegistryServices {
  return { workspace: new WorkspaceService(root), database: db, environment }
}

describe('ToolRegistry 定义与只读过滤（移植 test_tool_registry_definitions_and_read_only_filter）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('返回稳定定义与 plan-mode 只读工具，未知工具转失败', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    expect(registry.definitions()).toEqual(defaultToolDefinitions())
    expect(new Set(Object.keys(toolDefinitionsByName()))).toEqual(
      new Set(defaultToolDefinitions().map((d) => d.name)),
    )
    expect(registry.definitions().map((d) => d.name)).toEqual([
      'read_file',
      'write_file',
      'grep',
      'run_shell',
      'remember_fact',
      'recall_memory',
      'read_memory_artifact',
      'spawn_explore_agent',
      'list_mcp_servers',
    ])
    expect(registry.definitions(true).map((d) => d.name)).toEqual([
      'read_file',
      'grep',
      'recall_memory',
      'read_memory_artifact',
      'spawn_explore_agent',
      'list_mcp_servers',
    ])
    expect(registry.has('read_file')).toBe(true)
    expect(registry.has('glob')).toBe(false)
    const unknown = await registry.execute('glob', {})
    expect(JSON.parse(unknown.output).error).toBe('Unknown tool: glob')
    expect(unknown.status).toBe('failed')
  })
})

describe('workspace 文件工具（移植 test_tool_registry_executes_workspace_file_tools）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('read_file 与 write_file 经 workspace 边界执行；黑名单路径失败', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    const written = await registry.execute('write_file', {
      path: 'notes/demo.md',
      content: 'hello',
    })
    const read = await registry.execute('read_file', { path: 'notes/demo.md' })
    const blocked = await registry.execute('read_file', { path: '.git/config' })

    expect(written.status).toBe('completed')
    expect(JSON.parse(written.output).strategy).toBe('whole_file_overwrite')
    expect(JSON.parse(written.output).bytesWritten).toBe(5)
    expect(JSON.parse(read.output).content).toBe('hello')
    expect(blocked.status).toBe('failed')
  })
})

describe('grep 可见文件（移植 test_tool_registry_greps_visible_workspace_files）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('grep 搜索可见文件并跳过黑名单内部', async () => {
    const root = makeWorkspaceDir()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.py'), "marker = 'kodeks'\n")
    writeFileSync(join(root, 'src', 'b.py'), 'nothing here\n')
    const registry = buildDefaultToolRegistry(makeServices(root, db))

    const result = await registry.execute('grep', { query: 'kodeks' })

    expect(JSON.parse(result.output).matches).toEqual([
      { path: 'src/a.py', line: 1, text: "marker = 'kodeks'" },
    ])
  })
})

describe('run_shell 审批（移植 test_tool_registry_records_shell_approval_requests）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('危险 run_shell 调用成为持久审批记录与审计行', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    const result = await registry.execute(
      'run_shell',
      { command: 'rm -rf output' },
      { sessionId: 's1', toolCallId: 'call_1' },
    )
    const output = JSON.parse(result.output)
    const approval = await db.approvals.getApproval(output.approvalId)
    const audit = await db.connection.execute('SELECT * FROM audit_log')

    expect(result.status).toBe('approval_required')
    expect(output.approvalRequired).toBe(true)
    // 键序逐字：ok,approvalRequired,approvalId,status,reason,command。
    expect(Object.keys(output)).toEqual([
      'ok',
      'approvalRequired',
      'approvalId',
      'status',
      'reason',
      'command',
    ])
    expect(output.reason).toBe('Command requires approval')
    expect(approval.sessionId).toBe('s1')
    expect(approval.toolCallId).toBe('call_1')
    expect(String(audit.rows[0].event_type)).toBe('approval_required')
  })

  it('shell-only 语法不审批，走普通失败结果（exitCode=null, approvalRequired=false）', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    const result = await registry.execute('run_shell', { command: 'pytest -q | tee log' })
    const output = JSON.parse(result.output)

    expect(result.status).toBe('completed')
    expect(output.ok).toBe(false)
    expect(output.exitCode).toBeNull()
    expect(output.approvalRequired).toBe(false)
    expect(output.stderr).toContain('without a shell')
  })
})

describe('memory 与 subagent 工具（移植 test_tool_registry_memory_and_subagent_tools）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('memory 与 explore 工具保留 harness 输出契约', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    const remembered = await registry.execute(
      'remember_fact',
      { content: 'Kodeks plan mode is read only.', scope: 'project' },
      { sessionId: 's1', toolCallId: 'call_1' },
    )
    const recalled = await registry.execute('recall_memory', { query: 'plan mode' })
    const subagent = await registry.execute(
      'spawn_explore_agent',
      { task: 'inspect workspace package' },
      { sessionId: 's1', toolCallId: 'call_2' },
    )
    const subagentOutput = JSON.parse(subagent.output)
    const auditRows = await db.connection.execute(
      'SELECT event_type FROM audit_log ORDER BY rowid ASC',
    )
    const auditEvents = auditRows.rows.map((row) => String(row.event_type))

    expect(JSON.parse(remembered.output).scope).toBe('project')
    expect(JSON.parse(recalled.output).memories[0].sourceSessionId).toBe('s1')
    expect(JSON.parse(recalled.output).layered.atoms[0].content).toBe(
      'Kodeks plan mode is read only.',
    )
    expect(subagentOutput.status).toBe('completed')
    expect(subagentOutput.allowedTools).toEqual([
      'read_file',
      'grep',
      'recall_memory',
      'read_memory_artifact',
    ])
    expect(subagentOutput.parentSessionId).toBe('s1')
    expect(subagentOutput.contract.claim).toBe('Read-only workspace exploration completed.')
    expect(['low', 'medium']).toContain(subagentOutput.contract.confidence)
    expect(subagentOutput.quarantine).toEqual({
      readOnly: true,
      canMutateWorkspace: false,
      canRequestApproval: false,
    })
    expect((await db.subagents.getRun(subagentOutput.runId))?.parentSessionId).toBe('s1')
    expect(auditEvents).toEqual(['subagent_started', 'subagent_completed'])
  })

  it('read_memory_artifact 未知 refId 失败；spawn_explore_agent 缺 session → session_unknown', async () => {
    const registry = buildDefaultToolRegistry(makeServices(makeWorkspaceDir(), db))

    const missing = await registry.execute('read_memory_artifact', { refId: 'nope' })
    const missingOut = JSON.parse(missing.output)
    expect(missing.status).toBe('failed')
    expect(missingOut.error).toBe('Unknown memory artifact: nope')
    expect(missingOut.refId).toBe('nope')

    // 无 context → session_unknown，无可见文件 → evidence 空 → confidence low。
    const sub = await registry.execute('spawn_explore_agent', { task: 'x' })
    const subOut = JSON.parse(sub.output)
    expect(subOut.parentSessionId).toBe('session_unknown')
    expect(subOut.contract.confidence).toBe('low')
    expect(subOut.contract.evidence).toEqual([])
    expect(subOut.summary).toContain('no visible files')
  })
})

describe('MCP 列举（移植 test_tool_registry_lists_mcp_manifests）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })
  afterEach(() => db.close())

  it('MCP 工具读本地配置且不开网络客户端', async () => {
    const registry = buildDefaultToolRegistry(
      makeServices(makeWorkspaceDir(), db, {
        KODEKS_MCP_SERVERS: JSON.stringify([
          {
            label: 'deepwiki',
            url: 'https://example.com/mcp',
            allowedTools: ['search'],
            skipApproval: true,
          },
        ]),
      }),
    )

    const mcp = await registry.execute('list_mcp_servers', {})
    const output = JSON.parse(mcp.output)

    expect(output.servers[0].label).toBe('deepwiki')
    expect(output.count).toBe(1)
  })
})

describe('helpers 安全行为（保真红线对照）', () => {
  it('stringArgument allow_empty 双行为：true 保留原始未 trim，false 返回 trim', () => {
    // allowEmpty=false：返回 trim 后值；纯空白 → null。
    expect(stringArgument({ k: '  hi  ' }, 'k')).toBe('hi')
    expect(stringArgument({ k: '   ' }, 'k')).toBeNull()
    expect(stringArgument({ k: 42 }, 'k')).toBeNull()
    // allowEmpty=true：返回原始未 trim 值；空串保留。
    expect(stringArgument({ k: '  hi  ' }, 'k', true)).toBe('  hi  ')
    expect(stringArgument({ k: '' }, 'k', true)).toBe('')
    // 但非空白判定仍是 trim 后；纯空白在 allowEmpty=true 时返回原值。
    expect(stringArgument({ k: '   ' }, 'k', true)).toBe('   ')
  })

  it('clampInteger 拒绝非整数/NaN/布尔并夹取范围（grep 1..1000/20、recall 1..50/5）', () => {
    expect(clampInteger(5, 1, 1000, 20)).toBe(5)
    expect(clampInteger(0, 1, 1000, 20)).toBe(1)
    expect(clampInteger(5000, 1, 1000, 20)).toBe(1000)
    expect(clampInteger(2.5, 1, 1000, 20)).toBe(20)
    expect(clampInteger(Number.NaN, 1, 1000, 20)).toBe(20)
    expect(clampInteger(true, 1, 50, 5)).toBe(5)
    expect(clampInteger('3', 1, 50, 5)).toBe(5)
    expect(clampInteger(undefined, 1, 50, 5)).toBe(5)
    expect(clampInteger(100, 1, 50, 5)).toBe(50)
  })

  it('readMemoryLayers 非法/缺省回退 [atom,artifact]', () => {
    expect(readMemoryLayers(['atom'])).toEqual(['atom'])
    expect(readMemoryLayers(['artifact', 'atom'])).toEqual(['artifact', 'atom'])
    expect(readMemoryLayers(['bogus'])).toEqual(['atom', 'artifact'])
    expect(readMemoryLayers('atom')).toEqual(['atom', 'artifact'])
    expect(readMemoryLayers([])).toEqual(['atom', 'artifact'])
  })

  it('jsonOutput 紧凑无空格且保留键插入序', () => {
    expect(jsonOutput({ ok: true, b: 1, a: 2 })).toBe('{"ok":true,"b":1,"a":2}')
  })

  it('failedOutput 形状 {ok:false,error,...extra}，error 在前 extra 在后', () => {
    const result = failedOutput('boom', { path: 'x', code: 7 })
    expect(result.status).toBe('failed')
    expect(result.output).toBe('{"ok":false,"error":"boom","path":"x","code":7}')
    expect(Object.keys(JSON.parse(result.output))).toEqual(['ok', 'error', 'path', 'code'])
  })

  it('splitCsv / parseMcpServerManifests / readMcpServerManifests 单条 URL 回退', () => {
    expect(splitCsv(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(splitCsv(null)).toEqual([])
    // 畸形 JSON → []。
    expect(parseMcpServerManifests('{not json')).toEqual([])
    // 缺 url 项被丢弃。
    expect(parseMcpServerManifests(JSON.stringify([{ label: 'x' }]))).toEqual([])
    // 单条 URL 路径：label 默认 default、skipApproval 仅当 'true'。
    expect(
      readMcpServerManifests({
        KODEKS_MCP_SERVER_URL: ' https://e.com ',
        KODEKS_MCP_ALLOWED_TOOLS: 'a,b',
      }),
    ).toEqual([
      { label: 'default', url: 'https://e.com', allowedTools: ['a', 'b'], skipApproval: false },
    ])
  })
})
