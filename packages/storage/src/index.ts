import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export type SessionMode = "act" | "plan";

export type StoredSession = {
  id: string;
  title: string;
  mode: SessionMode;
  workspaceRoot: string;
  parentSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type StoredMessage = {
  id: string;
  sessionId: string;
  role: string;
  content: unknown;
  agentEvent: unknown | null;
  createdAt: string;
};

export type StoredMemory = {
  id: string;
  scope: string;
  content: string;
  sourceSessionId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type StoredApproval = {
  id: string;
  sessionId: string | null;
  toolCallId: string | null;
  command: unknown;
  status: "pending" | "approved" | "rejected" | "executed";
  reason: string;
  createdAt: string;
  decidedAt: string | null;
};

export type StoredSubagentRun = {
  id: string;
  parentSessionId: string;
  agentName: string;
  task: string;
  summary: string | null;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt: string | null;
};

export type StoredAuditLogEntry = {
  id: string;
  sessionId: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

type SqliteDatabaseConstructor = new (path?: string) => SqliteDatabase;

export class ApprovalNotFoundError extends Error {
  // Names approval lookup failures so API routes can map them to 404.
  constructor(approvalId: string) {
    super(`Approval not found: ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  // Names double-decision failures so API routes can map them to 409.
  constructor(approvalId: string) {
    super(`Approval already resolved: ${approvalId}`);
    this.name = "ApprovalAlreadyResolvedError";
  }
}

export class KodeksDatabase {
  readonly sessions: SessionRepository;
  readonly memories: MemoryRepository;
  readonly approvals: ApprovalRepository;
  readonly subagents: SubagentRepository;
  readonly auditLog: AuditLogRepository;

  private readonly database: SqliteDatabase;

  // 打开本地 SQLite 数据库，并初始化 MVP 需要的表结构。
  constructor(path: string = ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new (loadSqliteDatabase())(path);
    this.initializeSchema();
    this.sessions = new SessionRepository(this);
    this.memories = new MemoryRepository(this);
    this.approvals = new ApprovalRepository(this);
    this.subagents = new SubagentRepository(this);
    this.auditLog = new AuditLogRepository(this);
  }

  // 只把底层 SQLite 连接暴露给本 package 内部的 repository。
  connection(): SqliteDatabase {
    return this.database;
  }

  // 在测试结束或服务关闭时释放 SQLite 连接。
  close(): void {
    this.database.close();
  }

  // Creates all durable tables used by the TypeScript MVP.
  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        parent_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        agent_event_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        tool_call_id TEXT,
        command_json TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        task TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
}

// 优先加载 Bun 的 SQLite；在 Vitest/Node 这类暂时不支持 bun:sqlite 的环境里回退 node:sqlite。
function loadSqliteDatabase(): SqliteDatabaseConstructor {
  const require = createRequire(import.meta.url);
  if ("Bun" in globalThis) {
    return require("bun:sqlite").Database as SqliteDatabaseConstructor;
  }

  return require("node:sqlite").DatabaseSync as SqliteDatabaseConstructor;
}

export class SessionRepository {
  // Stores multi-session metadata and transcript messages.
  constructor(private readonly database: KodeksDatabase) {}

  // Creates or replaces one session record.
  async createSession(input: {
    id?: string;
    title: string;
    mode: SessionMode;
    workspaceRoot: string;
    parentSessionId?: string | null;
  }): Promise<StoredSession> {
    const now = currentTimestamp();
    const session: StoredSession = {
      id: input.id ?? prefixedId("sess"),
      title: input.title,
      mode: input.mode,
      workspaceRoot: input.workspaceRoot,
      parentSessionId: input.parentSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO sessions
          (id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          mode = excluded.mode,
          workspace_root = excluded.workspace_root,
          parent_session_id = excluded.parent_session_id,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at`
      )
      .run(
        session.id,
        session.title,
        session.mode,
        session.workspaceRoot,
        session.parentSessionId,
        session.createdAt,
        session.updatedAt,
        session.archivedAt
      );
    return session;
  }

  // Returns one session by id, or null when it does not exist.
  async getSession(id: string): Promise<StoredSession | null> {
    const row = this.database
      .connection()
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | null | undefined;
    return row == null ? null : mapSession(row);
  }

  // Lists non-archived sessions newest-first.
  async listSessions(): Promise<StoredSession[]> {
    const rows = this.database
      .connection()
      .prepare("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC")
      .all() as SessionRow[];
    return rows.map(mapSession);
  }

  // Updates the current session mode for plan/act transitions.
  async updateMode(id: string, mode: SessionMode): Promise<void> {
    this.database
      .connection()
      .prepare("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, currentTimestamp(), id);
  }

  // Appends one transcript message or mapped agent event.
  async appendMessage(input: {
    sessionId: string;
    role: string;
    content: unknown;
    agentEvent?: unknown | null;
  }): Promise<StoredMessage> {
    const message: StoredMessage = {
      id: prefixedId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      agentEvent: input.agentEvent ?? null,
      createdAt: currentTimestamp()
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO messages
          (id, session_id, role, content_json, agent_event_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        message.agentEvent === null ? null : JSON.stringify(message.agentEvent),
        message.createdAt
      );
    return message;
  }

  // Loads transcript messages in insertion order for session resume.
  async getTranscript(sessionId: string): Promise<StoredMessage[]> {
    const rows = this.database
      .connection()
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }
}

export class MemoryRepository {
  // Stores explicit and auditable memory records with lightweight recall.
  constructor(private readonly database: KodeksDatabase) {}

  // Stores one memory record and returns its id.
  async remember(input: {
    scope: "user" | "project" | "session" | string;
    content: string;
    sourceSessionId?: string | null;
    confidence?: number;
  }): Promise<string> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("Memory content is empty");
    }
    const id = prefixedId("mem");
    const now = currentTimestamp();
    this.database
      .connection()
      .prepare(
        `INSERT INTO memories
          (id, scope, content, source_session_id, confidence, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(id, input.scope, content, input.sourceSessionId ?? null, input.confidence ?? 1, now, now);
    return id;
  }

  // Recalls non-deleted memories ranked by keyword overlap and recency.
  async recall(query: string, limit = 5): Promise<StoredMemory[]> {
    const queryTerms = memoryTerms(query);
    if (queryTerms.size === 0) {
      return [];
    }
    const rows = this.database
      .connection()
      .prepare("SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC")
      .all() as MemoryRow[];
    const ranked = rows
      .map((row) => ({ memory: mapMemory(row), score: overlapScore(queryTerms, memoryTerms(row.content)) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt));
    return ranked.slice(0, limit).map((item) => item.memory);
  }

  // Soft-deletes one memory so audit history can remain intact.
  async delete(id: string): Promise<void> {
    this.database
      .connection()
      .prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(currentTimestamp(), currentTimestamp(), id);
  }
}

export class ApprovalRepository {
  // Persists approval state for dangerous shell/tool actions.
  constructor(private readonly database: KodeksDatabase) {}

  // Creates one pending approval request.
  async createApproval(input: {
    sessionId?: string | null;
    toolCallId?: string | null;
    command: unknown;
    reason: string;
  }): Promise<StoredApproval> {
    const approval: StoredApproval = {
      id: prefixedId("appr"),
      sessionId: input.sessionId ?? null,
      toolCallId: input.toolCallId ?? null,
      command: input.command,
      status: "pending",
      reason: input.reason,
      createdAt: currentTimestamp(),
      decidedAt: null
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO approvals
          (id, session_id, tool_call_id, command_json, status, reason, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.toolCallId,
        JSON.stringify(approval.command),
        approval.status,
        approval.reason,
        approval.createdAt,
        approval.decidedAt
      );
    return approval;
  }

  // Returns one approval or raises a domain error.
  async getApproval(id: string): Promise<StoredApproval> {
    const row = this.database
      .connection()
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as ApprovalRow | null | undefined;
    if (row == null) {
      throw new ApprovalNotFoundError(id);
    }
    return mapApproval(row);
  }

  // Marks a pending approval as approved exactly once.
  async approve(id: string): Promise<StoredApproval> {
    return this.resolve(id, "approved");
  }

  // Marks a pending approval as rejected exactly once.
  async reject(id: string, reason: string): Promise<StoredApproval> {
    const approval = await this.resolve(id, "rejected");
    this.database.connection().prepare("UPDATE approvals SET reason = ? WHERE id = ?").run(reason, id);
    return {
      ...approval,
      reason
    };
  }

  // Marks an approved command as executed exactly once.
  async markExecuted(id: string): Promise<StoredApproval> {
    const approval = await this.getApproval(id);
    if (approval.status !== "approved") {
      throw new ApprovalAlreadyResolvedError(id);
    }
    const decidedAt = currentTimestamp();
    this.database
      .connection()
      .prepare("UPDATE approvals SET status = 'executed', decided_at = ? WHERE id = ?")
      .run(decidedAt, id);
    return {
      ...approval,
      status: "executed",
      decidedAt
    };
  }

  // Resolves one pending approval while preventing double decisions.
  private async resolve(id: string, status: "approved" | "rejected"): Promise<StoredApproval> {
    const approval = await this.getApproval(id);
    if (approval.status !== "pending") {
      throw new ApprovalAlreadyResolvedError(id);
    }
    const decidedAt = currentTimestamp();
    this.database
      .connection()
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?")
      .run(status, decidedAt, id);
    return {
      ...approval,
      status,
      decidedAt
    };
  }
}

export class SubagentRepository {
  // Stores read-only subagent run lifecycle records.
  constructor(private readonly database: KodeksDatabase) {}

  // Starts a subagent run and returns its durable id.
  async startRun(input: {
    parentSessionId: string;
    agentName: "explore" | string;
    task: string;
  }): Promise<StoredSubagentRun> {
    const run: StoredSubagentRun = {
      id: prefixedId("sub"),
      parentSessionId: input.parentSessionId,
      agentName: input.agentName,
      task: input.task,
      summary: null,
      status: "running",
      createdAt: currentTimestamp(),
      completedAt: null
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO subagent_runs
          (id, parent_session_id, agent_name, task, summary, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.parentSessionId,
        run.agentName,
        run.task,
        run.summary,
        run.status,
        run.createdAt,
        run.completedAt
      );
    return run;
  }

  // Completes one running subagent with a compact summary.
  async completeRun(id: string, summary: string): Promise<StoredSubagentRun> {
    const completedAt = currentTimestamp();
    this.database
      .connection()
      .prepare("UPDATE subagent_runs SET summary = ?, status = 'completed', completed_at = ? WHERE id = ?")
      .run(summary, completedAt, id);
    const run = await this.getRun(id);
    if (run === null) {
      throw new Error(`Subagent run not found: ${id}`);
    }
    return run;
  }

  // Loads one subagent run by id.
  async getRun(id: string): Promise<StoredSubagentRun | null> {
    const row = this.database
      .connection()
      .prepare("SELECT * FROM subagent_runs WHERE id = ?")
      .get(id) as SubagentRow | null | undefined;
    return row == null ? null : mapSubagentRun(row);
  }
}

export class AuditLogRepository {
  // Stores append-only product audit events in SQLite.
  constructor(private readonly database: KodeksDatabase) {}

  // Records one audit event with a structured payload.
  async record(input: {
    sessionId?: string | null;
    eventType: string;
    payload: unknown;
  }): Promise<StoredAuditLogEntry> {
    const entry: StoredAuditLogEntry = {
      id: prefixedId("audit"),
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: currentTimestamp()
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO audit_log
          (id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.id, entry.sessionId, entry.eventType, JSON.stringify(entry.payload), entry.createdAt);
    return entry;
  }

  // Lists audit events for one session in insertion order.
  async listBySession(sessionId: string): Promise<StoredAuditLogEntry[]> {
    const rows = this.database
      .connection()
      .prepare("SELECT * FROM audit_log WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId) as AuditLogRow[];
    return rows.map(mapAuditLogEntry);
  }
}

type SessionRow = {
  id: string;
  title: string;
  mode: SessionMode;
  workspace_root: string;
  parent_session_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content_json: string;
  agent_event_json: string | null;
  created_at: string;
};

type MemoryRow = {
  id: string;
  scope: string;
  content: string;
  source_session_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ApprovalRow = {
  id: string;
  session_id: string | null;
  tool_call_id: string | null;
  command_json: string;
  status: StoredApproval["status"];
  reason: string;
  created_at: string;
  decided_at: string | null;
};

type SubagentRow = {
  id: string;
  parent_session_id: string;
  agent_name: string;
  task: string;
  summary: string | null;
  status: StoredSubagentRun["status"];
  created_at: string;
  completed_at: string | null;
};

type AuditLogRow = {
  id: string;
  session_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
};

// Maps SQLite snake_case session rows into TypeScript domain objects.
function mapSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    workspaceRoot: row.workspace_root,
    parentSessionId: row.parent_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  };
}

// Maps SQLite message rows into parsed transcript messages.
function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: JSON.parse(row.content_json) as unknown,
    agentEvent: row.agent_event_json === null ? null : (JSON.parse(row.agent_event_json) as unknown),
    createdAt: row.created_at
  };
}

// Maps SQLite memory rows into memory domain objects.
function mapMemory(row: MemoryRow): StoredMemory {
  return {
    id: row.id,
    scope: row.scope,
    content: row.content,
    sourceSessionId: row.source_session_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

// Maps SQLite approval rows into approval domain objects.
function mapApproval(row: ApprovalRow): StoredApproval {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    command: JSON.parse(row.command_json) as unknown,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  };
}

// Maps SQLite subagent rows into subagent run domain objects.
function mapSubagentRun(row: SubagentRow): StoredSubagentRun {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    agentName: row.agent_name,
    task: row.task,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

// Maps SQLite audit rows into parsed audit event objects.
function mapAuditLogEntry(row: AuditLogRow): StoredAuditLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at
  };
}

// Generates a compact durable id with a readable prefix.
function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

// Returns an ISO timestamp for records that need stable JSON serialization.
function currentTimestamp(): string {
  return new Date().toISOString();
}

// Extracts lightweight recall terms for the MVP memory scorer.
function memoryTerms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_\u4e00-\u9fff]+/gu)?.filter((term) => term.length > 1) ?? []);
}

// Counts how many query terms are present in a memory record.
function overlapScore(queryTerms: Set<string>, contentTerms: Set<string>): number {
  let score = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}
