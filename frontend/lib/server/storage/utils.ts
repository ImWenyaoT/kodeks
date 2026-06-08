// frontend/lib/server/storage/utils.ts
// 存储层共享工具：时间戳、id、SHA256、UTF-8 字节长度、行→camelCase 契约映射。
// 逐字节忠实移植自 Python src/kodeks/storage/utils.py 与 memory.py 的派生算法。
//
// 保真红线（见 40-storage.md 保真风险 1/2/3）：
//  · currentTimestamp 必须是 6 位微秒（不能直接用 Date.toISOString 的 3 位毫秒）。
//  · prefixedId = `${prefix}_${32 位小写无连字符 hex}`。
//  · 存库 JSON 列读出时用 JSON.parse；映射输出全 camelCase。
import { createHash, randomUUID } from 'node:crypto'
import type { Row } from '@libsql/client'
import type {
  StoredApproval,
  StoredMessage,
  StoredPlanArtifact,
  StoredSession,
} from './types'

/**
 * 返回与 Python `datetime.now(UTC).isoformat().replace("+00:00","Z")` 等价的 ISO 时间戳。
 * 关键：补足到 6 位微秒。JS `toISOString()` 只产 3 位毫秒（.123Z），
 * 这里把 .fffZ 末尾补 3 个 0 成 .ffffffZ（与 Python 输出形如 2026-06-08T12:34:56.123000Z 一致）。
 */
export function currentTimestamp(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')
}

/**
 * 生成带前缀的紧凑 id（移植 prefixed_id，utils.py:26-29）。
 * 形如 `<prefix>_<32位小写无连字符 hex>`（复刻 Python `f"{prefix}_{uuid4().hex}"`）。
 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

/**
 * 计算文本的 SHA256 十六进制摘要（小写，移植 memory.py:136 sha256(...).hexdigest()）。
 * 显式按 UTF-8 编码以匹配 Python `output.encode("utf-8")`。
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

/**
 * 计算文本的 UTF-8 字节长度（移植 memory.py:133 len(output.encode("utf-8"))）。
 */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

// ── 行取值辅助（libSQL Value = null | string | number | bigint | ArrayBuffer）──

/** 把一列读为可空字符串：null/undefined → null，其余 String 化。 */
function asTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** 把一列读为非空字符串（NOT NULL 列）。 */
function asText(value: unknown): string {
  return String(value)
}

/** 把一列读为数值（REAL/INTEGER 列；bigint → number 以匹配 Python int/float 语义）。 */
function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number)
}

// ── 行 → 契约映射（逐字移植 utils.py:32-90，输出 camelCase）──────────────────

/** 把一行 sessions 映射为 StoredSession 契约（移植 map_session，utils.py:32-44）。 */
export function mapSession(row: Row): StoredSession {
  return {
    id: asText(row.id),
    title: asText(row.title),
    mode: asText(row.mode) as StoredSession['mode'],
    workspaceRoot: asText(row.workspace_root),
    parentSessionId: asTextOrNull(row.parent_session_id),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
    archivedAt: asTextOrNull(row.archived_at),
  }
}

/**
 * 把一行 messages 映射为 StoredMessage 契约（移植 map_message，utils.py:47-59）。
 * content_json 必读 JSON.parse；agent_event_json 为 SQL NULL 时 → null，否则 JSON.parse。
 */
export function mapMessage(row: Row): StoredMessage {
  const agentEventJson = row.agent_event_json
  return {
    id: asText(row.id),
    sessionId: asText(row.session_id),
    role: asText(row.role),
    content: JSON.parse(asText(row.content_json)),
    agentEvent:
      agentEventJson === null || agentEventJson === undefined
        ? null
        : JSON.parse(String(agentEventJson)),
    createdAt: asText(row.created_at),
  }
}

/** 把一行 approvals 映射为 StoredApproval 契约（移植 map_approval，utils.py:62-74）。 */
export function mapApproval(row: Row): StoredApproval {
  return {
    id: asText(row.id),
    sessionId: asTextOrNull(row.session_id),
    toolCallId: asTextOrNull(row.tool_call_id),
    command: JSON.parse(asText(row.command_json)),
    status: asText(row.status) as StoredApproval['status'],
    reason: asText(row.reason),
    createdAt: asText(row.created_at),
    decidedAt: asTextOrNull(row.decided_at),
  }
}

/** 把一行 plan_artifacts 映射为 StoredPlanArtifact 契约（移植 map_plan，utils.py:77-90）。 */
export function mapPlan(row: Row): StoredPlanArtifact {
  return {
    id: asText(row.id),
    sessionId: asText(row.session_id),
    title: asText(row.title),
    summary: asText(row.summary),
    steps: JSON.parse(asText(row.steps_json)),
    status: asText(row.status) as StoredPlanArtifact['status'],
    sourceMessageId: asTextOrNull(row.source_message_id),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  }
}

// 内部数值取值辅助导出给 repository 复用（byte_length 等 INTEGER 列）。
export { asNumber, asText, asTextOrNull }
