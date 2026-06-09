// frontend/lib/server/storage/repositories/memory.ts
// 内存 artifact 与 subagent run repository：逐字节忠实移植自 Python src/kodeks/storage/memory.py。
// 全异步；双写/分层 recall/>4KB 落盘/SHA256/紧凑 JSON 返回/camelCase dict 逐字保真。
//
// 保真红线（见 40-storage.md §5/§6、保真风险 4/5/6/7/8/10）：
//  · remember 双写 memories+memory_atoms（用 batch 原子），返回 mem_ 那个 memory_id。
//  · recall 按 content LIKE；_recall_artifacts 按 summary LIKE（不是 content）。
//  · compact_tool_result：byteLength <= threshold(4096) 直接返回 output（恰好 4096 不落盘）；
//    超阈值算 sha256/refId/summary、落盘逐字模板、写元数据、返回紧凑 JSON（键顺序固定，message 逐字常量）。
//  · summarizeArtifactOutput：前 6 个非空 strip 行单空格连接，>240 则 slice(0,239).trimEnd()，空回退 `Large {tool} output`。
import type { Client } from '@libsql/client'
import type { ArtifactStore } from '../artifact-store'
import { asNumber, asText, asTextOrNull, currentTimestamp, prefixedId, sha256Hex, utf8ByteLength } from '../utils'
import type {
  ArtifactContent,
  LayeredRecall,
  RecalledArtifact,
  RecalledAtom,
  RecalledMemory,
  StoredArtifact,
  SubagentRun,
} from '../types'

/** repository 依赖：libSQL 连接 + artifact 落盘后端。 */
export interface HasMemoryDependencies {
  connection: Client
  artifactStore: ArtifactStore
}

/**
 * 为一个被卸载的工具结果构建紧凑摘要（移植 summarize_artifact_output，memory.py:366-373）。
 * 1) 去空白行并对每行 strip；2) 取前 6 行用单空格连接（空则用 output.strip）；
 * 3) 若 len>240 则截到 239 再 trimEnd（注意是 239 不是 240）；4) 空时回退 `Large {tool_name} output`。
 */
export function summarizeArtifactOutput(toolName: string, output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let preview = lines.length > 0 ? lines.slice(0, 6).join(' ') : output.trim()
  if (preview.length > 240) {
    preview = preview.slice(0, 239).replace(/\s+$/, '')
  }
  return preview || `Large ${toolName} output`
}

/**
 * 工具所用最小内存记录的存取 repository（移植 MemoryRepository，memory.py:13）。
 */
export class MemoryRepository {
  private readonly database: HasMemoryDependencies

  constructor(database: HasMemoryDependencies) {
    this.database = database
  }

  /**
   * 存一条内存事实并镜像入 atom 层（移植 remember，memory.py:19-53）。
   * 先 INSERT memories（mem_, confidence=1.0, deleted_at=null），
   * 再 INSERT memory_atoms（atom_, confidence=1.0, freshness=1.0, deleted_at=null）；
   * 双写用 batch 保证原子（对应 Python 单次 commit）。返回 mem_ 的 memory_id。
   */
  async remember(
    scope: string,
    content: string,
    sourceSessionId: string | null = null,
  ): Promise<string> {
    const now = currentTimestamp()
    const memoryId = prefixedId('mem')
    await this.database.connection.batch(
      [
        {
          sql: `
            INSERT INTO memories
              (id, scope, content, source_session_id, confidence, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
          args: [memoryId, scope, content, sourceSessionId, 1.0, now, now, null],
        },
        {
          sql: `
            INSERT INTO memory_atoms
              (id, scope, content, source_session_id, confidence, freshness, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          args: [prefixedId('atom'), scope, content, sourceSessionId, 1.0, 1.0, now, now, null],
        },
      ],
      'write',
    )
    return memoryId
  }

  /**
   * 按字面 content 匹配召回简单内存行（移植 recall，memory.py:55-78）。
   * WHERE deleted_at IS NULL AND content LIKE ? ORDER BY updated_at DESC, rowid DESC LIMIT ?。
   */
  async recall(query: string, limit: number): Promise<RecalledMemory[]> {
    const result = await this.database.connection.execute({
      sql: `
            SELECT * FROM memories
            WHERE deleted_at IS NULL AND content LIKE ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?
            `,
      args: [`%${query}%`, limit],
    })
    return result.rows.map((row) => ({
      id: asText(row.id),
      scope: asText(row.scope),
      content: asText(row.content),
      sourceSessionId: asTextOrNull(row.source_session_id),
      confidence: asNumber(row.confidence),
      createdAt: asText(row.created_at),
      updatedAt: asText(row.updated_at),
    }))
  }

  /**
   * 召回 harness 所用的有界事实层与 artifact 层（移植 recall_layered，memory.py:80-92）。
   * atoms 仅当 "atom" ∈ layers 否则 []；artifacts 仅当 "artifact" ∈ layers 否则 []。
   * 返回键固定为 "atoms"/"artifacts"（复数）。
   */
  async recallLayered(query: string, limit: number, layers: string[]): Promise<LayeredRecall> {
    return {
      atoms: layers.includes('atom') ? await this.recallLayer('memory_atoms', query, limit) : [],
      artifacts: layers.includes('artifact') ? await this.recallArtifacts(query, limit) : [],
    }
  }

  /**
   * 按 ref id 读取一个卸载到磁盘的内存 artifact 正文（移植 read_artifact_content，memory.py:94-120）。
   * 无行返回 null；file_path 不是文件返回 null；否则返回 {artifact, content}。
   */
  async readArtifactContent(refId: string): Promise<ArtifactContent | null> {
    const result = await this.database.connection.execute({
      sql: 'SELECT * FROM memory_artifacts WHERE ref_id = ? AND deleted_at IS NULL',
      args: [refId],
    })
    const row = result.rows[0]
    if (row === undefined) {
      return null
    }
    const filePath = asText(row.file_path)
    const content = await this.database.artifactStore.read(filePath)
    if (content === null) {
      return null
    }
    return {
      artifact: {
        id: asText(row.id),
        refId: asText(row.ref_id),
        sessionId: asTextOrNull(row.session_id),
        toolCallId: asTextOrNull(row.tool_call_id),
        toolName: asText(row.tool_name),
        summary: asText(row.summary),
        filePath: asText(row.file_path),
        byteLength: asNumber(row.byte_length),
        contentHash: asText(row.content_hash),
        createdAt: asText(row.created_at),
      },
      content,
    }
  }

  /**
   * 把超大的成功工具输出卸载为内存 artifact（移植 compact_tool_result，memory.py:122-183）。
   * byteLength <= threshold(默认 4096) → 直接返回 output（恰好 4096 不落盘，<= 边界）。
   * 超阈值：算 content_hash/ref_id/summary，落盘逐字模板（tool_call_id falsy → 'unknown'），
   * 写元数据行，返回紧凑 JSON（键顺序 ok,offloaded,refId,toolName,summary,byteLength,message，message 逐字常量）。
   */
  async compactToolResult(
    workspaceRoot: string,
    sessionId: string,
    toolCallId: string | null,
    toolName: string,
    output: string,
    thresholdBytes = 4096,
  ): Promise<string> {
    const byteLength = utf8ByteLength(output)
    if (byteLength <= thresholdBytes) {
      return output
    }
    const contentHash = sha256Hex(output)
    const refId = `memref_${contentHash.slice(0, 16)}`
    const summary = summarizeArtifactOutput(toolName, output)
    // 逐字落盘模板（memory.py:142-160）；toolCallId falsy 时写字面量 'unknown'。
    const fileContent = [
      `# ${toolName} tool result`,
      '',
      `- ref: ${refId}`,
      `- session: ${sessionId}`,
      `- toolCall: ${toolCallId || 'unknown'}`,
      `- bytes: ${byteLength}`,
      '',
      '## Summary',
      '',
      summary,
      '',
      '## Full Output',
      '',
      output,
    ].join('\n')
    const filePath = await this.database.artifactStore.write(refId, fileContent)
    const artifact = await this.rememberArtifact(
      refId,
      sessionId,
      toolCallId,
      toolName,
      summary,
      filePath,
      byteLength,
      contentHash,
    )
    // 返回紧凑 JSON（JSON.stringify 默认无空格，对应 Python separators=(",",":")）；键顺序逐字。
    return JSON.stringify({
      ok: true,
      offloaded: true,
      refId: artifact.refId,
      toolName: artifact.toolName,
      summary: artifact.summary,
      byteLength: artifact.byteLength,
      message:
        'Large tool output was stored as a memory artifact. Use read_memory_artifact with refId to inspect the full output.',
    })
  }

  /**
   * 为一个卸载的内存 artifact 写入元数据（移植 remember_artifact，memory.py:185-230）。
   * id=prefixed_id("mart")，deleted_at 列写 SQL 字面量 NULL，返回 camelCase dict（含 createdAt）。
   */
  async rememberArtifact(
    refId: string,
    sessionId: string | null,
    toolCallId: string | null,
    toolName: string,
    summary: string,
    filePath: string,
    byteLength: number,
    contentHash: string,
  ): Promise<StoredArtifact> {
    const artifact: StoredArtifact = {
      id: prefixedId('mart'),
      refId,
      sessionId,
      toolCallId,
      toolName,
      summary,
      filePath,
      byteLength,
      contentHash,
      createdAt: currentTimestamp(),
    }
    await this.database.connection.execute({
      sql: `
            INSERT INTO memory_artifacts
              (id, ref_id, session_id, tool_call_id, tool_name, summary, file_path, byte_length, content_hash, created_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            `,
      args: [
        artifact.id,
        artifact.refId,
        artifact.sessionId,
        artifact.toolCallId,
        artifact.toolName,
        artifact.summary,
        artifact.filePath,
        artifact.byteLength,
        artifact.contentHash,
        artifact.createdAt,
      ],
    })
    return artifact
  }

  /**
   * 召回一个字面搜索的内存表（移植 _recall_layer，memory.py:232-258）。
   * 表名仅允许内部白名单（此处仅传 "memory_atoms"）；返回键含 freshness。
   * WHERE deleted_at IS NULL AND content LIKE ? ORDER BY updated_at DESC, rowid DESC LIMIT ?。
   */
  private async recallLayer(
    table: 'memory_atoms',
    query: string,
    limit: number,
  ): Promise<RecalledAtom[]> {
    const result = await this.database.connection.execute({
      sql: `
            SELECT * FROM ${table}
            WHERE deleted_at IS NULL AND content LIKE ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?
            `,
      args: [`%${query}%`, limit],
    })
    return result.rows.map((row) => ({
      id: asText(row.id),
      scope: asText(row.scope),
      content: asText(row.content),
      sourceSessionId: asTextOrNull(row.source_session_id),
      confidence: asNumber(row.confidence),
      freshness: asNumber(row.freshness),
      createdAt: asText(row.created_at),
      updatedAt: asText(row.updated_at),
    }))
  }

  /**
   * 按 summary 召回卸载的内存 artifact 元数据（移植 _recall_artifacts，memory.py:260-284）。
   * 注意按 summary LIKE（不是 content）；ORDER BY created_at DESC, rowid DESC LIMIT ?。
   * 返回键不含 sessionId/toolCallId。
   */
  private async recallArtifacts(query: string, limit: number): Promise<RecalledArtifact[]> {
    const result = await this.database.connection.execute({
      sql: `
            SELECT * FROM memory_artifacts
            WHERE deleted_at IS NULL AND summary LIKE ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            `,
      args: [`%${query}%`, limit],
    })
    return result.rows.map((row) => ({
      id: asText(row.id),
      refId: asText(row.ref_id),
      toolName: asText(row.tool_name),
      summary: asText(row.summary),
      filePath: asText(row.file_path),
      byteLength: asNumber(row.byte_length),
      contentHash: asText(row.content_hash),
      createdAt: asText(row.created_at),
    }))
  }
}

/**
 * 有界 subagent 探索 run 记录 repository（移植 SubagentRepository，memory.py:287）。
 */
export class SubagentRepository {
  private readonly database: { connection: Client }

  constructor(database: { connection: Client }) {
    this.database = database
  }

  /** 创建一条 running 的 subagent 记录（移植 start_run，memory.py:293-326）。summary=null，status="running"。 */
  async startRun(parentSessionId: string, agentName: string, task: string): Promise<SubagentRun> {
    const run: SubagentRun = {
      id: prefixedId('sub'),
      parentSessionId,
      agentName,
      task,
      summary: null,
      status: 'running',
      createdAt: currentTimestamp(),
      completedAt: null,
    }
    await this.database.connection.execute({
      sql: `
            INSERT INTO subagent_runs
              (id, parent_session_id, agent_name, task, summary, status, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
      args: [
        run.id,
        run.parentSessionId,
        run.agentName,
        run.task,
        run.summary,
        run.status,
        run.createdAt,
        run.completedAt,
      ],
    })
    return run
  }

  /**
   * 把一条 subagent run 标记为 completed（移植 complete_run，memory.py:328-344）。
   * UPDATE ... SET summary=?, status='completed', completed_at=? WHERE id=?；回读 get_run，为 null 抛 RuntimeError。
   */
  async completeRun(runId: string, summary: string): Promise<SubagentRun> {
    const completedAt = currentTimestamp()
    await this.database.connection.execute({
      sql: `
            UPDATE subagent_runs
            SET summary = ?, status = 'completed', completed_at = ?
            WHERE id = ?
            `,
      args: [summary, completedAt, runId],
    })
    const run = await this.getRun(runId)
    if (run === null) {
      throw new Error(`Subagent run not found: ${runId}`)
    }
    return run
  }

  /** 读取一条 subagent run（移植 get_run，memory.py:346-363）。无行返回 null。 */
  async getRun(runId: string): Promise<SubagentRun | null> {
    const result = await this.database.connection.execute({
      sql: 'SELECT * FROM subagent_runs WHERE id = ?',
      args: [runId],
    })
    const row = result.rows[0]
    if (row === undefined) {
      return null
    }
    return {
      id: asText(row.id),
      parentSessionId: asText(row.parent_session_id),
      agentName: asText(row.agent_name),
      task: asText(row.task),
      summary: asTextOrNull(row.summary),
      status: asText(row.status),
      createdAt: asText(row.created_at),
      completedAt: asTextOrNull(row.completed_at),
    }
  }
}
