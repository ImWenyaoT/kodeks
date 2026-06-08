// frontend/lib/server/storage/repositories/session.ts
// 会话 / 审批 / 计划 / 审计 repository：逐字节忠实移植自 Python src/kodeks/storage/session.py。
// 全异步（@libsql/client 异步驱动）；方法签名/SQL/排序/id 前缀/JSON 列/camelCase 输出/状态机/错误类逐字保真。
//
// 保真红线（见 40-storage.md §5、保真风险 5/6/9/11/12）：
//  · create_session upsert 冲突不更新 created_at（只更新 title/mode/workspace_root/parent_session_id/updated_at/archived_at）。
//  · approval 三条更新列集合各异；非满足前置状态抛 ApprovalAlreadyResolvedError；未找到抛 ApprovalNotFoundError（逐字消息）。
//  · list_sessions ORDER BY updated_at DESC, id ASC + WHERE archived_at IS NULL；get_transcript ORDER BY rowid ASC。
//  · agent_event 为 null 时写 SQL NULL（不是字符串 "null"）；JSON 列存库用 JSON.stringify。
import type { Client } from '@libsql/client'
import {
  currentTimestamp,
  mapApproval,
  mapMessage,
  mapPlan,
  mapSession,
  prefixedId,
} from '../utils'
import type {
  AuditEventType,
  StoredApproval,
  StoredMessage,
  StoredPlanArtifact,
  StoredPlanStep,
  StoredSession,
} from '../types'

/** repository 依赖：暴露一个 libSQL 异步连接（对应 Python HasConnection Protocol，utils.py:14-17）。 */
export interface HasConnection {
  connection: Client
}

/** approval id 不存在时抛出（移植 ApprovalNotFoundError，session.py:26-27）。 */
export class ApprovalNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalNotFoundError'
  }
}

/** 对仅限 pending 的 approval 动作重复执行时抛出（移植 ApprovalAlreadyResolvedError，session.py:30-31）。 */
export class ApprovalAlreadyResolvedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalAlreadyResolvedError'
  }
}

/**
 * 会话元数据与 transcript 消息 repository（移植 SessionRepository，session.py:34）。
 */
export class SessionRepository {
  private readonly database: HasConnection

  constructor(database: HasConnection) {
    this.database = database
  }

  /**
   * 创建或替换一条会话记录（移植 create_session，session.py:40-86）。
   * id = session_id 或 prefixed_id("sess")；createdAt=updatedAt=now，archivedAt=null。
   * upsert 冲突时不更新 created_at（保真风险 9）。
   */
  async createSession(
    title: string,
    mode: string,
    workspaceRoot: string,
    sessionId: string | null = null,
    parentSessionId: string | null = null,
  ): Promise<StoredSession> {
    const now = currentTimestamp()
    const session: StoredSession = {
      id: sessionId ?? prefixedId('sess'),
      title,
      mode: mode as StoredSession['mode'],
      workspaceRoot,
      parentSessionId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    await this.database.connection.execute({
      sql: `
            INSERT INTO sessions
              (id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              mode = excluded.mode,
              workspace_root = excluded.workspace_root,
              parent_session_id = excluded.parent_session_id,
              updated_at = excluded.updated_at,
              archived_at = excluded.archived_at
            `,
      args: [
        session.id,
        session.title,
        session.mode,
        session.workspaceRoot,
        session.parentSessionId,
        session.createdAt,
        session.updatedAt,
        session.archivedAt,
      ],
    })
    return session
  }

  /** 按 id 返回一条会话，无则 null（移植 get_session，session.py:88-94）。 */
  async getSession(sessionId: string): Promise<StoredSession | null> {
    const result = await this.database.connection.execute({
      sql: 'SELECT * FROM sessions WHERE id = ?',
      args: [sessionId],
    })
    const row = result.rows[0]
    return row !== undefined ? mapSession(row) : null
  }

  /**
   * 列出未归档会话，最新优先（移植 list_sessions，session.py:96-102）。
   * ORDER BY updated_at DESC, id ASC + WHERE archived_at IS NULL（逐字）。
   */
  async listSessions(): Promise<StoredSession[]> {
    const result = await this.database.connection.execute(
      'SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC',
    )
    return result.rows.map((row) => mapSession(row))
  }

  /** 更新会话当前模式（移植 update_mode，session.py:104-111）。 */
  async updateMode(sessionId: string, mode: string): Promise<void> {
    await this.database.connection.execute({
      sql: 'UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?',
      args: [mode, currentTimestamp(), sessionId],
    })
  }

  /**
   * 追加一条 transcript 消息或映射后的 agent 事件（移植 append_message，session.py:113-148）。
   * content → JSON.stringify；agent_event 为 null 时写 SQL NULL，否则 JSON.stringify。
   */
  async appendMessage(
    sessionId: string,
    role: string,
    content: unknown,
    agentEvent: unknown = null,
  ): Promise<StoredMessage> {
    const message: StoredMessage = {
      id: prefixedId('msg'),
      sessionId,
      role,
      content,
      agentEvent: agentEvent ?? null,
      createdAt: currentTimestamp(),
    }
    await this.database.connection.execute({
      sql: `
            INSERT INTO messages
              (id, session_id, role, content_json, agent_event_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            `,
      args: [
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        message.agentEvent === null || message.agentEvent === undefined
          ? null
          : JSON.stringify(message.agentEvent),
        message.createdAt,
      ],
    })
    return message
  }

  /**
   * 按插入顺序加载 transcript 消息（移植 get_transcript，session.py:150-157）。
   * ORDER BY rowid ASC（逐字）。
   */
  async getTranscript(sessionId: string): Promise<StoredMessage[]> {
    const result = await this.database.connection.execute({
      sql: 'SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC',
      args: [sessionId],
    })
    return result.rows.map((row) => mapMessage(row))
  }
}

/**
 * 危险命令审批记录 repository（移植 ApprovalRepository，session.py:160）。
 */
export class ApprovalRepository {
  private readonly database: HasConnection

  constructor(database: HasConnection) {
    this.database = database
  }

  /** 创建一条 pending 审批（移植 create_approval，session.py:166-203）。command → JSON.stringify。 */
  async createApproval(
    command: unknown,
    reason: string,
    sessionId: string | null = null,
    toolCallId: string | null = null,
  ): Promise<StoredApproval> {
    const approval: StoredApproval = {
      id: prefixedId('appr'),
      sessionId,
      toolCallId,
      command,
      status: 'pending',
      reason,
      createdAt: currentTimestamp(),
      decidedAt: null,
    }
    await this.database.connection.execute({
      sql: `
            INSERT INTO approvals
              (id, session_id, tool_call_id, command_json, status, reason, created_at, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
      args: [
        approval.id,
        approval.sessionId,
        approval.toolCallId,
        JSON.stringify(approval.command),
        approval.status,
        approval.reason,
        approval.createdAt,
        approval.decidedAt,
      ],
    })
    return approval
  }

  /** 返回一条审批，未找到抛稳定 not-found 错误（移植 get_approval，session.py:205-213）。 */
  async getApproval(approvalId: string): Promise<StoredApproval> {
    const result = await this.database.connection.execute({
      sql: 'SELECT * FROM approvals WHERE id = ?',
      args: [approvalId],
    })
    const row = result.rows[0]
    if (row === undefined) {
      throw new ApprovalNotFoundError(`Approval not found: ${approvalId}`)
    }
    return mapApproval(row)
  }

  /** 把 pending 审批标记为 approved（移植 approve，session.py:215-218）。status 与 reason 都设为 "approved"。 */
  async approve(approvalId: string): Promise<StoredApproval> {
    return this.resolve(approvalId, 'approved', 'approved')
  }

  /**
   * 把 pending 审批标记为 rejected 并附用户原因（移植 reject，session.py:220-233）。
   * 要求当前 status === "pending"，否则抛 ApprovalAlreadyResolvedError；更新 status/reason/decided_at。
   */
  async reject(approvalId: string, reason: string): Promise<StoredApproval> {
    const approval = await this.getApproval(approvalId)
    if (approval.status !== 'pending') {
      throw new ApprovalAlreadyResolvedError(`Approval already resolved: ${approvalId}`)
    }
    await this.database.connection.execute({
      sql: "UPDATE approvals SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ?",
      args: [reason, currentTimestamp(), approvalId],
    })
    return this.getApproval(approvalId)
  }

  /**
   * 把 approved 命令标记为 executed（仅一次，移植 mark_executed，session.py:235-248）。
   * 要求当前 status === "approved"，否则抛 ApprovalAlreadyResolvedError；只更新 status/decided_at（不改 reason）。
   */
  async markExecuted(approvalId: string): Promise<StoredApproval> {
    const approval = await this.getApproval(approvalId)
    if (approval.status !== 'approved') {
      throw new ApprovalAlreadyResolvedError(`Approval already resolved: ${approvalId}`)
    }
    await this.database.connection.execute({
      sql: "UPDATE approvals SET status = 'executed', decided_at = ? WHERE id = ?",
      args: [currentTimestamp(), approvalId],
    })
    return this.getApproval(approvalId)
  }

  /**
   * 把一条 pending 审批移入其最终决定状态（移植 _resolve，session.py:250-263）。
   * 要求当前 status === "pending"，否则抛 ApprovalAlreadyResolvedError；更新 status/reason/decided_at。
   */
  private async resolve(
    approvalId: string,
    status: string,
    reason: string,
  ): Promise<StoredApproval> {
    const approval = await this.getApproval(approvalId)
    if (approval.status !== 'pending') {
      throw new ApprovalAlreadyResolvedError(`Approval already resolved: ${approvalId}`)
    }
    await this.database.connection.execute({
      sql: 'UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ?',
      args: [status, reason, currentTimestamp(), approvalId],
    })
    return this.getApproval(approvalId)
  }
}

/**
 * active plan 工件读写 repository（移植 PlanRepository，session.py:266）。
 */
export class PlanRepository {
  private readonly database: HasConnection

  constructor(database: HasConnection) {
    this.database = database
  }

  /**
   * 返回某会话最新的 active plan（移植 get_active_by_session，session.py:272-284）。
   * WHERE session_id = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1（逐字）。
   */
  async getActiveBySession(sessionId: string): Promise<StoredPlanArtifact | null> {
    const result = await this.database.connection.execute({
      sql: `
            SELECT * FROM plan_artifacts
            WHERE session_id = ? AND status = 'active'
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
            `,
      args: [sessionId],
    })
    const row = result.rows[0]
    return row !== undefined ? mapPlan(row) : null
  }

  /**
   * 归档现有 plan 并创建一条 active plan 工件（移植 upsert_active，session.py:286-324）。
   * 1) 先归档：UPDATE ... SET status='archived', updated_at=? WHERE session_id=? AND status='active'。
   * 2) 插入新 active：id=prefixed_id("plan")，steps → JSON.stringify，created_at=updated_at=now。
   * 3) 回读 get_active_by_session，为 null 抛 RuntimeError。
   * 两步写入用 batch 保证原子（对应 Python 单次 commit）。
   */
  async upsertActive(
    sessionId: string,
    title: string,
    summary: string,
    steps: StoredPlanStep[],
    sourceMessageId: string | null = null,
  ): Promise<StoredPlanArtifact> {
    const now = currentTimestamp()
    const planId = prefixedId('plan')
    await this.database.connection.batch(
      [
        {
          sql: "UPDATE plan_artifacts SET status = 'archived', updated_at = ? WHERE session_id = ? AND status = 'active'",
          args: [now, sessionId],
        },
        {
          sql: `
            INSERT INTO plan_artifacts
              (id, session_id, title, summary, steps_json, status, source_message_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          args: [
            planId,
            sessionId,
            title,
            summary,
            JSON.stringify(steps),
            'active',
            sourceMessageId,
            now,
            now,
          ],
        },
      ],
      'write',
    )
    const plan = await this.getActiveBySession(sessionId)
    if (plan === null) {
      throw new Error(`Plan artifact not found after insert: ${planId}`)
    }
    return plan
  }
}

/**
 * 可审计后端动作记录 repository（移植 AuditLogRepository，session.py:327）。
 * append-only，无读方法。
 */
export class AuditLogRepository {
  private readonly database: HasConnection

  constructor(database: HasConnection) {
    this.database = database
  }

  /** 追加一条审计日志（移植 record，session.py:333-351）。payload → JSON.stringify。 */
  async record(
    sessionId: string | null,
    eventType: AuditEventType,
    payload: unknown,
  ): Promise<void> {
    await this.database.connection.execute({
      sql: `
            INSERT INTO audit_log (id, session_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            `,
      args: [
        prefixedId('aud'),
        sessionId,
        eventType,
        JSON.stringify(payload),
        currentTimestamp(),
      ],
    })
  }
}
