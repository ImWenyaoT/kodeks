// frontend/lib/server/tools/registry.ts
// ToolRegistry + 9 个 handler：逐字节忠实移植 Python src/kodeks/tools/registry.py。
// 输出形状逐字段；审批是第三种工具状态；handler 异步（M2 存储异步）。
//
// 保真红线（见 50-tools-security.md §1/§4、保真风险 1/2/8/9/10）：
//  · execute 未知工具 → failed_output("Unknown tool: <name>")。
//  · run_shell 危险命令分支产 status:'approval_required'，输出键序 ok,approvalRequired,approvalId,status,reason,command；
//    并 createApproval({command}) + auditLog.record(sid,'approval_required',{approvalId,command})。
//  · read_memory_artifact 输出键序 ok,refId,artifact,content（artifact 字段展开）。
//  · spawn_explore_agent 是确定性桩：session||'session_unknown'、listFiles(12)、evidence=visible[:5]、CERCN 逐字。
//  · plan-mode schema 由 definitions(readOnlyOnly) 裁剪；执行层 allowlist 守卫在 agent/tool-loop.ts。
//  · mutating/read_only 只驱动 mode allowlist，不替代 run_shell 审批。
import {
  type ShellResult,
  ShellCommandTimeoutError,
  runCommand,
} from '../workspace'
import {
  clampInteger,
  completedOutput,
  errorMessage,
  failedOutput,
  jsonOutput,
  readMcpServerManifests,
  readMemoryLayers,
  runtimeEnvironment,
  stringArgument,
} from './helpers'
import { toolDefinitionsByName } from './schemas'
import type {
  RegisteredTool,
  ToolArguments,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistryServices,
} from './types'

/** 按公共工具名存确定性工具定义与 handler（移植 ToolRegistry，registry.py:32-63）。 */
export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool>

  /** @param tools 已注册工具列表，按注册顺序入 Map（Map 保留插入序）。 */
  constructor(tools: RegisteredTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.definition.name, tool]))
  }

  /**
   * 按稳定注册顺序返回 provider-facing 定义（移植 definitions，registry.py:38-45）。
   * readOnlyOnly=true 时过滤条件为 tool.readOnly && !tool.mutating（与 schema 裁剪结果一致，独立路径）。
   */
  definitions(readOnlyOnly = false): ToolDefinition[] {
    const result: ToolDefinition[] = []
    for (const tool of this.tools.values()) {
      if (!readOnlyOnly || (tool.readOnly && !tool.mutating)) {
        result.push(tool.definition)
      }
    }
    return result
  }

  /** 返回工具名是否已注册（移植 has，registry.py:47-50）。 */
  has(toolName: string): boolean {
    return this.tools.has(toolName)
  }

  /**
   * 执行一个已注册工具，未知工具转为失败（移植 execute，registry.py:52-63）。
   * @param context 可选执行上下文；缺省为空 context（sessionId/toolCallId 均 undefined）。
   */
  async execute(
    toolName: string,
    args: ToolArguments,
    context: ToolExecutionContext = {},
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName)
    if (tool === undefined) {
      return failedOutput(`Unknown tool: ${toolName}`)
    }
    return tool.handler(args, context)
  }
}

/**
 * 从本地服务构建默认 Kodeks 工具注册表（移植 build_default_tool_registry，registry.py:66-135）。
 * 9 个工具按固定顺序注册，readOnly/mutating 标志逐字对齐 Python。
 */
export function buildDefaultToolRegistry(services: ToolRegistryServices): ToolRegistry {
  const definitions = toolDefinitionsByName()
  return new ToolRegistry([
    {
      definition: definitions.read_file,
      readOnly: true,
      mutating: false,
      handler: (args) => executeReadFile(args, services),
    },
    {
      definition: definitions.write_file,
      readOnly: false,
      mutating: true,
      handler: (args) => executeWriteFile(args, services),
    },
    {
      definition: definitions.grep,
      readOnly: true,
      mutating: false,
      handler: (args) => executeGrep(args, services),
    },
    {
      definition: definitions.run_shell,
      readOnly: false,
      mutating: true,
      handler: (args, context) => executeRunShell(args, context, services),
    },
    {
      definition: definitions.remember_fact,
      readOnly: false,
      mutating: true,
      handler: (args, context) => executeRememberFact(args, context, services),
    },
    {
      definition: definitions.recall_memory,
      readOnly: true,
      mutating: false,
      handler: (args) => executeRecallMemory(args, services),
    },
    {
      definition: definitions.read_memory_artifact,
      readOnly: true,
      mutating: false,
      handler: (args) => executeReadMemoryArtifact(args, services),
    },
    {
      definition: definitions.spawn_explore_agent,
      readOnly: true,
      mutating: false,
      handler: (args, context) => executeSpawnExploreAgent(args, context, services),
    },
    {
      definition: definitions.list_mcp_servers,
      readOnly: true,
      mutating: false,
      handler: () => executeListMcpServers(services),
    },
  ])
}

/** 经共享 workspace 边界执行 read_file（移植 execute_read_file，registry.py:138-151）。 */
async function executeReadFile(
  args: ToolArguments,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const path = stringArgument(args, 'path')
  if (path === null) {
    return failedOutput('read_file requires a non-empty string path')
  }
  try {
    return completedOutput({
      ok: true,
      path,
      content: services.workspace.readFile(path),
    })
  } catch (error) {
    return failedOutput(errorMessage(error), { path })
  }
}

/** 用整文件覆盖语义执行 write_file（移植 execute_write_file，registry.py:154-176）。 */
async function executeWriteFile(
  args: ToolArguments,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const path = stringArgument(args, 'path')
  // content 用 allowEmpty=true：允许空串且返回原始未 trim 值。
  const content = stringArgument(args, 'content', true)
  if (path === null) {
    return failedOutput('write_file requires a non-empty string path')
  }
  if (content === null) {
    return failedOutput('write_file requires string content', { path })
  }
  try {
    services.workspace.writeFile(path, content)
    return completedOutput({
      ok: true,
      path,
      strategy: 'whole_file_overwrite',
      // bytesWritten 用 UTF-8 字节长度（不是 content.length），对齐 Python len(content.encode())。
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    })
  } catch (error) {
    return failedOutput(errorMessage(error), { path })
  }
}

/** 在可见工作区文本文件上做字面 grep（移植 execute_grep，registry.py:179-201）。 */
async function executeGrep(
  args: ToolArguments,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const query = stringArgument(args, 'query')
  const limit = clampInteger(args.limit, 1, 1000, 20)
  if (query === null) {
    return failedOutput('grep requires a non-empty string query')
  }
  const matches: Array<{ path: string; line: number; text: string }> = []
  for (const path of services.workspace.listFiles()) {
    if (matches.length >= limit) {
      break
    }
    let content: string
    try {
      content = services.workspace.readFile(path)
    } catch {
      continue
    }
    // splitlines 等价：按行切分且不含换行符；行号从 1 起。
    const lines = content.split(/\r\n|\r|\n/)
    // Python splitlines 不会为末尾换行产生空尾行；这里若内容以换行结尾则去掉末尾空串。
    if (lines.length > 0 && lines[lines.length - 1] === '' && /[\r\n]$/.test(content)) {
      lines.pop()
    }
    let index = 0
    for (const line of lines) {
      index += 1
      if (line.includes(query)) {
        matches.push({ path, line: index, text: line })
      }
      if (matches.length >= limit) {
        break
      }
    }
  }
  return completedOutput({ ok: true, query, matches })
}

/** 执行 run_shell 并为危险命令记录审批请求（移植 execute_run_shell，registry.py:204-254）。 */
async function executeRunShell(
  args: ToolArguments,
  context: ToolExecutionContext,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const command = stringArgument(args, 'command')
  if (command === null) {
    return failedOutput('run_shell requires a non-empty string command')
  }
  let result: ShellResult
  try {
    result = await runCommand(command, services.workspace.rootPath())
  } catch (error) {
    if (error instanceof ShellCommandTimeoutError) {
      return failedOutput('Command timed out')
    }
    return failedOutput(errorMessage(error))
  }
  if (result.approvalRequired) {
    // 审批路径：创建 pending 审批 + 审计 approval_required，返回 approval_required 状态。
    const approval = await services.database.approvals.createApproval(
      { command },
      result.stderr,
      context.sessionId ?? null,
      context.toolCallId ?? null,
    )
    await services.database.auditLog.record(
      context.sessionId ?? null,
      'approval_required',
      { approvalId: approval.id, command },
    )
    return {
      status: 'approval_required',
      // 键序逐字：ok,approvalRequired,approvalId,status,reason,command。
      output: jsonOutput({
        ok: false,
        approvalRequired: true,
        approvalId: approval.id,
        status: approval.status,
        reason: approval.reason,
        command,
      }),
    }
  }
  // 正常路径：ok = exitCode === 0（timeout/parse 失败走异常/审批分支，不进此处）。
  return completedOutput({
    ok: result.exitCode === 0,
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    approvalRequired: false,
  })
}

/** 经内存 repository 执行 remember_fact（移植 execute_remember_fact，registry.py:257-273）。 */
async function executeRememberFact(
  args: ToolArguments,
  context: ToolExecutionContext,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const content = stringArgument(args, 'content')
  // scope 默认 "project"（Python `string_argument(...) or "project"`，空串也回退用 ||）。
  const scope = stringArgument(args, 'scope') || 'project'
  if (content === null) {
    return failedOutput('remember_fact requires non-empty string content')
  }
  const memoryId = await services.database.memories.remember(
    scope,
    content,
    context.sessionId ?? null,
  )
  return completedOutput({ ok: true, memoryId, scope, content })
}

/** 经内存 repository 执行 recall_memory（移植 execute_recall_memory，registry.py:276-296）。 */
async function executeRecallMemory(
  args: ToolArguments,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const query = stringArgument(args, 'query')
  const limit = clampInteger(args.limit, 1, 50, 5)
  if (query === null) {
    return failedOutput('recall_memory requires a non-empty string query')
  }
  const layers = readMemoryLayers(args.layers)
  return completedOutput({
    ok: true,
    query,
    layers,
    memories: await services.database.memories.recall(query, limit),
    layered: await services.database.memories.recallLayered(query, limit, layers),
  })
}

/** 经内存 repository 执行 read_memory_artifact（移植 execute_read_memory_artifact，registry.py:299-310）。 */
async function executeReadMemoryArtifact(
  args: ToolArguments,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const refId = stringArgument(args, 'refId')
  if (refId === null) {
    return failedOutput('read_memory_artifact requires a non-empty string refId')
  }
  const artifact = await services.database.memories.readArtifactContent(refId)
  if (artifact === null) {
    return failedOutput(`Unknown memory artifact: ${refId}`, { refId })
  }
  // 键序逐字：ok,refId,artifact,content（artifact dict 的 artifact/content 字段展开）。
  return completedOutput({ ok: true, refId, ...artifact })
}

/** 执行一个最小只读 explore 子代理 run（移植 execute_spawn_explore_agent，registry.py:313-368）。 */
async function executeSpawnExploreAgent(
  args: ToolArguments,
  context: ToolExecutionContext,
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const task = stringArgument(args, 'task')
  if (task === null) {
    return failedOutput('spawn_explore_agent requires a non-empty string task')
  }
  // 缺省字面量 "session_unknown"（Python `context.session_id or "session_unknown"`）。
  const sessionId = context.sessionId || 'session_unknown'
  const run = await services.database.subagents.startRun(sessionId, 'explore', task)
  // 最多 12 个文件。
  const visibleFiles = services.workspace.listFiles(12)
  // 逐字顺序固定的四项 allowedTools。
  const allowedTools = ['read_file', 'grep', 'recall_memory', 'read_memory_artifact']
  await services.database.auditLog.record(sessionId, 'subagent_started', {
    runId: run.id,
    agentName: run.agentName,
    task,
    allowedTools,
    visibleFileCount: visibleFiles.length,
  })
  const summary = subagentSummary(task, visibleFiles)
  const contract = subagentContract(task, visibleFiles)
  const completed = await services.database.subagents.completeRun(run.id, summary)
  await services.database.auditLog.record(sessionId, 'subagent_completed', {
    runId: completed.id,
    agentName: completed.agentName,
    status: completed.status,
    summary: completed.summary,
    allowedTools,
    contract,
  })
  return completedOutput({
    ok: true,
    runId: completed.id,
    status: completed.status,
    summary: completed.summary,
    allowedTools,
    parentSessionId: sessionId,
    contract,
    quarantine: {
      readOnly: true,
      canMutateWorkspace: false,
      canRequestApproval: false,
    },
  })
}

/** 不开网络客户端地列出已配置 MCP server manifests（移植 execute_list_mcp_servers，registry.py:371-375）。 */
async function executeListMcpServers(
  services: ToolRegistryServices,
): Promise<ToolExecutionResult> {
  const servers = readMcpServerManifests(runtimeEnvironment(services))
  return completedOutput({ ok: true, servers, count: servers.length })
}

/**
 * 从工作区清单构建有界只读子代理摘要（移植 _subagent_summary，registry.py:378-385）。
 * preview = visible[:5] 用 ", " 连接；无文件时 "no visible files"。文案逐字。
 */
function subagentSummary(task: string, visibleFiles: string[]): string {
  const preview =
    visibleFiles.length > 0 ? visibleFiles.slice(0, 5).join(', ') : 'no visible files'
  return `Read-only explore run completed. Task: ${task}. Visible workspace sample: ${preview}.`
}

/**
 * 为子代理输出构建结构化、便于综合的契约（移植 _subagent_contract，registry.py:388-398）。
 * evidence = visible[:5]；confidence 有 evidence → "medium" 否则 "low"。CERCN 字段顺序逐字。
 */
function subagentContract(
  task: string,
  visibleFiles: string[],
): {
  claim: string
  evidence: string[]
  risk: string
  confidence: string
  nextAction: string
} {
  const evidence = visibleFiles.slice(0, 5)
  return {
    claim: 'Read-only workspace exploration completed.',
    evidence,
    risk: 'This run only sampled visible files and did not mutate or execute commands.',
    confidence: evidence.length > 0 ? 'medium' : 'low',
    nextAction: `Main agent should synthesize this with the parent task: ${task}.`,
  }
}
