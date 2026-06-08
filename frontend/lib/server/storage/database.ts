// frontend/lib/server/storage/database.ts
// 存储门面：用 @libsql/client 作单一异步驱动（:memory: / file: / Turso），
// 逐字节忠实移植自 Python src/kodeks/storage/db.py 的 KodeksDatabase。
// 暴露 6 个 repository；建 schema、写 schema_version（ON CONFLICT DO NOTHING）、getSchemaVersion。
//
// 保真红线（见 40-storage.md §1、保真风险 10、门禁约束）：
//  · schema_version INSERT 用 ON CONFLICT DO NOTHING；CURRENT_SCHEMA_VERSION=1。
//  · 设 PRAGMA busy_timeout=5000 / foreign_keys=ON（libSQL 支持则设；schema 无 FK，仅保真）。
//  · 不设 journal_mode=WAL 的精确断言（远端/serverless 语义不同，非 wire 契约，不移植驱动级测试）。
import { type Client, createClient } from '@libsql/client'
import { type ArtifactStore, LocalFileArtifactStore } from './artifact-store'
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from './schema'
import { currentTimestamp } from './utils'
import {
  ApprovalRepository,
  AuditLogRepository,
  PlanRepository,
  SessionRepository,
} from './repositories/session'
import { MemoryRepository, SubagentRepository } from './repositories/memory'

/** createDatabase 选项。 */
export interface CreateDatabaseOptions {
  /** 内存 artifact 落盘后端；默认本地文件后端（落于 cwd 下的 .kodeks/memory-artifacts）。 */
  artifactStore?: ArtifactStore
  /**
   * Turso/libSQL 远端鉴权 token（M6）。
   * 仅在连远端（libsql:// URL）时需要；本地 :memory: / file: URL 不传亦正常工作。
   * 透传给 @libsql/client createClient({ url, authToken })，纯增量、不影响本地路径。
   */
  authToken?: string
}

/**
 * 打开一个 libSQL 数据库并暴露领域 repository（移植 KodeksDatabase，db.py:34）。
 * 构造私有；请用异步工厂 createDatabase。
 */
export class KodeksDatabase {
  readonly connection: Client
  readonly artifactStore: ArtifactStore
  readonly sessions: SessionRepository
  readonly approvals: ApprovalRepository
  readonly plans: PlanRepository
  readonly auditLog: AuditLogRepository
  readonly memories: MemoryRepository
  readonly subagents: SubagentRepository

  /** @internal 仅由 createDatabase 调用；外部请用 createDatabase 异步工厂。 */
  constructor(connection: Client, artifactStore: ArtifactStore) {
    this.connection = connection
    this.artifactStore = artifactStore
    // 6 个 repository 实例（顺序对应 db.py:45-50）。
    this.sessions = new SessionRepository(this)
    this.approvals = new ApprovalRepository(this)
    this.plans = new PlanRepository(this)
    this.auditLog = new AuditLogRepository(this)
    this.memories = new MemoryRepository(this)
    this.subagents = new SubagentRepository(this)
  }

  /** 关闭底层连接（移植 close，db.py:52-55）。 */
  close(): void {
    this.connection.close()
  }

  /**
   * 读取当前 schema 版本标记（移植 get_schema_version，db.py:91-97）。
   * 读 schema_metadata 的 schema_version 行；无行返回 0。
   */
  async getSchemaVersion(): Promise<number> {
    const result = await this.connection.execute(
      "SELECT * FROM schema_metadata WHERE key = 'schema_version'",
    )
    const row = result.rows[0]
    return row !== undefined ? Number(row.value) : 0
  }
}

/**
 * 配置连接 PRAGMA（移植 configure_connection，db.py:57-63）。
 * 设 busy_timeout=5000 与 foreign_keys=ON（libSQL 本地驱动支持）；失败则忽略
 * （远端/serverless 不支持某些 PRAGMA 时不应阻断初始化——这些非 wire 契约）。
 */
async function configureConnection(connection: Client): Promise<void> {
  try {
    await connection.execute('PRAGMA busy_timeout = 5000')
  } catch {
    // 远端驱动可能不支持；忽略（非保真契约）。
  }
  try {
    await connection.execute('PRAGMA foreign_keys = ON')
  } catch {
    // schema 无 FK，此 PRAGMA 仅为保真；不支持则忽略。
  }
}

/**
 * 初始化 schema 并写入版本标记（移植 initialize_schema，db.py:77-89）。
 * executeMultiple 执行 SCHEMA_SQL（对应 Python executescript），
 * 再 INSERT schema_version 用 ON CONFLICT(key) DO NOTHING。
 */
async function initializeSchema(connection: Client): Promise<void> {
  await connection.executeMultiple(SCHEMA_SQL)
  await connection.execute({
    sql: `
            INSERT INTO schema_metadata (key, value, updated_at)
            VALUES ('schema_version', ?, ?)
            ON CONFLICT(key) DO NOTHING
            `,
    args: [String(CURRENT_SCHEMA_VERSION), currentTimestamp()],
  })
}

/**
 * 异步工厂：打开 libSQL 库、配 PRAGMA、建 schema、写版本标记，返回 KodeksDatabase。
 * @param url 数据库 URL：':memory:'（默认）/ 'file:...' / Turso libsql: URL。
 * @param options 可选项；artifactStore 不传时默认 LocalFileArtifactStore(process.cwd())；
 *   authToken 不传时不进 createClient（保持本地 file:/:memory: 语义不变）。
 */
export async function createDatabase(
  url = ':memory:',
  options: CreateDatabaseOptions = {},
): Promise<KodeksDatabase> {
  // 仅当显式传入 authToken 时才带上该字段；本地 url 无 token 仍按原样建客户端（纯增量）。
  const connection = createClient(
    options.authToken !== undefined
      ? { url, authToken: options.authToken }
      : { url },
  )
  await configureConnection(connection)
  await initializeSchema(connection)
  const artifactStore = options.artifactStore ?? new LocalFileArtifactStore(process.cwd())
  return new KodeksDatabase(connection, artifactStore)
}
