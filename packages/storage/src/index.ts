import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  cosineSimilarity,
  createLocalHashEmbedding,
  readHuggingFaceEmbedding,
  readOllamaEmbedding,
  readOpenAICompatibleEmbedding,
  summarizeArtifactOutput,
  trimTrailingSlash,
} from "./memory-embeddings";

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

export type MemoryLayer = "atom" | "scenario" | "profile" | "artifact";

export type StoredMemoryEvent = {
  id: string;
  sessionId: string | null;
  role: string;
  content: string;
  eventType: string;
  sourceId: string | null;
  createdAt: string;
};

export type StoredMemoryAtom = {
  id: string;
  scope: string;
  content: string;
  sourceSessionId: string | null;
  confidence: number;
  freshness: number;
  legacyMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type StoredMemoryScenario = {
  id: string;
  scope: string;
  title: string;
  summary: string;
  sourceSessionId: string | null;
  confidence: number;
  freshness: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type StoredMemoryProfile = {
  id: string;
  scope: string;
  content: string;
  priority: number;
  sourceSessionId: string | null;
  confidence: number;
  freshness: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type StoredMemoryArtifact = {
  id: string;
  refId: string;
  sessionId: string | null;
  toolCallId: string | null;
  toolName: string;
  summary: string;
  filePath: string;
  byteLength: number;
  contentHash: string;
  createdAt: string;
  deletedAt: string | null;
};

export type MemoryRecallScore = {
  keyword: number;
  semantic: number;
  recency: number;
  confidence: number;
  freshness: number;
  total: number;
};

export type LayeredMemoryItem = {
  id: string;
  layer: MemoryLayer;
  scope: string;
  content: string;
  sourceId: string | null;
  updatedAt: string;
  score: MemoryRecallScore;
};

export type LayeredMemoryRecall = {
  atoms: LayeredMemoryItem[];
  scenarios: LayeredMemoryItem[];
  profiles: StoredMemoryProfile[];
  artifacts: LayeredMemoryItem[];
};

export type MemoryContext = {
  profiles: StoredMemoryProfile[];
  recalledItems: LayeredMemoryItem[];
  artifactRefs: StoredMemoryArtifact[];
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

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export type StoredPlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  details: string | null;
};

export type StoredPlanArtifact = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  steps: StoredPlanStep[];
  status: "active" | "archived";
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
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
  readonly plans: PlanRepository;
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
    this.plans = new PlanRepository(this);
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

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_atoms (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        confidence REAL NOT NULL,
        freshness REAL NOT NULL,
        legacy_memory_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_scenarios (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_session_id TEXT,
        confidence REAL NOT NULL,
        freshness REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_profiles (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        priority REAL NOT NULL,
        source_session_id TEXT,
        confidence REAL NOT NULL,
        freshness REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_artifacts (
        id TEXT PRIMARY KEY,
        ref_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        tool_call_id TEXT,
        tool_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        file_path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        content_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (content_hash, embedding_model)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
        id UNINDEXED,
        layer UNINDEXED,
        scope UNINDEXED,
        content,
        source_id UNINDEXED,
        updated_at UNINDEXED
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

      CREATE TABLE IF NOT EXISTS plan_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

// 加载 Node 内置 SQLite，同时避开 bundler 对 node:sqlite CommonJS require 的静态改写。
function loadSqliteDatabase(): SqliteDatabaseConstructor {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | { DatabaseSync?: SqliteDatabaseConstructor }
    | undefined;
  if (sqlite?.DatabaseSync === undefined) {
    throw new Error("Node built-in SQLite DatabaseSync is unavailable.");
  }
  return sqlite.DatabaseSync;
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
      archivedAt: null,
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
          archived_at = excluded.archived_at`,
      )
      .run(
        session.id,
        session.title,
        session.mode,
        session.workspaceRoot,
        session.parentSessionId,
        session.createdAt,
        session.updatedAt,
        session.archivedAt,
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
      .prepare(
        "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC",
      )
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
      createdAt: currentTimestamp(),
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO messages
          (id, session_id, role, content_json, agent_event_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        message.agentEvent === null ? null : JSON.stringify(message.agentEvent),
        message.createdAt,
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
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.scope,
        content,
        input.sourceSessionId ?? null,
        input.confidence ?? 1,
        now,
        now,
      );
    await this.rememberAtom({
      scope: input.scope,
      content,
      sourceSessionId: input.sourceSessionId ?? null,
      confidence: input.confidence ?? 1,
      freshness: 1,
      legacyMemoryId: id,
    });
    return id;
  }

  // Recalls non-deleted memories ranked by keyword overlap and recency.
  async recall(query: string, limit = 5): Promise<StoredMemory[]> {
    const atoms = await this.recallAtoms(query, limit);
    return atoms.map((atom) => ({
      id: atom.legacyMemoryId ?? atom.id,
      scope: atom.scope,
      content: atom.content,
      sourceSessionId: atom.sourceSessionId,
      confidence: atom.confidence,
      createdAt: atom.createdAt,
      updatedAt: atom.updatedAt,
      deletedAt: atom.deletedAt,
    }));
  }

  // Soft-deletes one memory so audit history can remain intact.
  async delete(id: string): Promise<void> {
    this.database
      .connection()
      .prepare(
        "UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(currentTimestamp(), currentTimestamp(), id);
    this.deleteAtomByLegacyMemoryId(id);
  }

  // Records one raw L0 memory event for later auditable extraction.
  async recordEvent(input: {
    sessionId?: string | null;
    role: string;
    content: string;
    eventType: string;
    sourceId?: string | null;
  }): Promise<StoredMemoryEvent> {
    const event: StoredMemoryEvent = {
      id: prefixedId("mevt"),
      sessionId: input.sessionId ?? null,
      role: input.role,
      content: input.content.trim(),
      eventType: input.eventType,
      sourceId: input.sourceId ?? null,
      createdAt: currentTimestamp(),
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_events
          (id, session_id, role, content, event_type, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.role,
        event.content,
        event.eventType,
        event.sourceId,
        event.createdAt,
      );
    return event;
  }

  // Stores one L1 atom and indexes it for FTS recall.
  async rememberAtom(input: {
    scope: string;
    content: string;
    sourceSessionId?: string | null;
    confidence?: number;
    freshness?: number;
    legacyMemoryId?: string | null;
  }): Promise<StoredMemoryAtom> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("Memory atom content is empty");
    }
    const now = currentTimestamp();
    const atom: StoredMemoryAtom = {
      id: prefixedId("matom"),
      scope: input.scope,
      content,
      sourceSessionId: input.sourceSessionId ?? null,
      confidence: input.confidence ?? 1,
      freshness: input.freshness ?? 1,
      legacyMemoryId: input.legacyMemoryId ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_atoms
          (id, scope, content, source_session_id, confidence, freshness, legacy_memory_id, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        atom.id,
        atom.scope,
        atom.content,
        atom.sourceSessionId,
        atom.confidence,
        atom.freshness,
        atom.legacyMemoryId,
        atom.createdAt,
        atom.updatedAt,
      );
    this.indexSearchItem({
      id: atom.id,
      layer: "atom",
      scope: atom.scope,
      content: atom.content,
      sourceId: atom.sourceSessionId,
      updatedAt: atom.updatedAt,
    });
    return atom;
  }

  // Stores one L2 scenario summary and indexes it for recall.
  async rememberScenario(input: {
    scope: string;
    title: string;
    summary: string;
    sourceSessionId?: string | null;
    confidence?: number;
    freshness?: number;
  }): Promise<StoredMemoryScenario> {
    const now = currentTimestamp();
    const scenario: StoredMemoryScenario = {
      id: prefixedId("mscn"),
      scope: input.scope,
      title: input.title.trim() || "Scenario",
      summary: input.summary.trim(),
      sourceSessionId: input.sourceSessionId ?? null,
      confidence: input.confidence ?? 1,
      freshness: input.freshness ?? 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_scenarios
          (id, scope, title, summary, source_session_id, confidence, freshness, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        scenario.id,
        scenario.scope,
        scenario.title,
        scenario.summary,
        scenario.sourceSessionId,
        scenario.confidence,
        scenario.freshness,
        scenario.createdAt,
        scenario.updatedAt,
      );
    this.indexSearchItem({
      id: scenario.id,
      layer: "scenario",
      scope: scenario.scope,
      content: `${scenario.title}\n${scenario.summary}`,
      sourceId: scenario.sourceSessionId,
      updatedAt: scenario.updatedAt,
    });
    return scenario;
  }

  // Stores one L3 profile item for always-on user or project memory.
  async rememberProfile(input: {
    scope: string;
    content: string;
    priority?: number;
    sourceSessionId?: string | null;
    confidence?: number;
    freshness?: number;
  }): Promise<StoredMemoryProfile> {
    const now = currentTimestamp();
    const profile: StoredMemoryProfile = {
      id: prefixedId("mprf"),
      scope: input.scope,
      content: input.content.trim(),
      priority: input.priority ?? 1,
      sourceSessionId: input.sourceSessionId ?? null,
      confidence: input.confidence ?? 1,
      freshness: input.freshness ?? 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_profiles
          (id, scope, content, priority, source_session_id, confidence, freshness, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        profile.id,
        profile.scope,
        profile.content,
        profile.priority,
        profile.sourceSessionId,
        profile.confidence,
        profile.freshness,
        profile.createdAt,
        profile.updatedAt,
      );
    return profile;
  }

  // Returns active L3 profile items in injection priority order.
  async listProfiles(limit = 5): Promise<StoredMemoryProfile[]> {
    const rows = this.database
      .connection()
      .prepare(
        "SELECT * FROM memory_profiles WHERE deleted_at IS NULL ORDER BY priority DESC, updated_at DESC LIMIT ?",
      )
      .all(limit) as MemoryProfileRow[];
    return rows.map(mapMemoryProfile);
  }

  // Stores artifact metadata for a large offloaded tool result.
  async rememberArtifact(input: {
    refId: string;
    sessionId?: string | null;
    toolCallId?: string | null;
    toolName: string;
    summary: string;
    filePath: string;
    byteLength: number;
    contentHash: string;
  }): Promise<StoredMemoryArtifact> {
    const artifact: StoredMemoryArtifact = {
      id: prefixedId("mart"),
      refId: input.refId,
      sessionId: input.sessionId ?? null,
      toolCallId: input.toolCallId ?? null,
      toolName: input.toolName,
      summary: input.summary,
      filePath: input.filePath,
      byteLength: input.byteLength,
      contentHash: input.contentHash,
      createdAt: currentTimestamp(),
      deletedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_artifacts
          (id, ref_id, session_id, tool_call_id, tool_name, summary, file_path, byte_length, content_hash, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
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
      );
    this.indexSearchItem({
      id: artifact.id,
      layer: "artifact",
      scope: "session",
      content: `${artifact.toolName}\n${artifact.summary}`,
      sourceId: artifact.refId,
      updatedAt: artifact.createdAt,
    });
    return artifact;
  }

  // Reads artifact metadata by ref id.
  async getArtifactByRef(refId: string): Promise<StoredMemoryArtifact | null> {
    const row = this.database
      .connection()
      .prepare(
        "SELECT * FROM memory_artifacts WHERE ref_id = ? AND deleted_at IS NULL",
      )
      .get(refId) as MemoryArtifactRow | null | undefined;
    return row == null ? null : mapMemoryArtifact(row);
  }

  // Reads an offloaded artifact body from its stored file path.
  async readArtifactContent(refId: string): Promise<{
    artifact: StoredMemoryArtifact;
    content: string;
  } | null> {
    const artifact = await this.getArtifactByRef(refId);
    if (artifact === null) {
      return null;
    }
    return {
      artifact,
      content: await readFile(artifact.filePath, "utf8"),
    };
  }

  // Stores or replaces one local embedding vector in SQLite.
  async rememberEmbedding(input: {
    contentHash: string;
    embeddingModel: string;
    vector: number[];
  }): Promise<void> {
    const vector = new Float32Array(input.vector);
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_embeddings
          (content_hash, embedding_model, dimensions, vector_blob, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(content_hash, embedding_model) DO UPDATE SET
          dimensions = excluded.dimensions,
          vector_blob = excluded.vector_blob,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.contentHash,
        input.embeddingModel,
        vector.length,
        new Uint8Array(vector.buffer),
        currentTimestamp(),
      );
  }

  // Loads one cached embedding vector, or null when it has not been generated.
  async getEmbedding(
    contentHash: string,
    embeddingModel: string,
  ): Promise<number[] | null> {
    const row = this.database
      .connection()
      .prepare(
        "SELECT * FROM memory_embeddings WHERE content_hash = ? AND embedding_model = ?",
      )
      .get(contentHash, embeddingModel) as
      | MemoryEmbeddingRow
      | null
      | undefined;
    if (row == null) {
      return null;
    }
    const bytes = row.vector_blob;
    const slice = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    return [...new Float32Array(slice)];
  }

  // Recalls L1/L2/artifact candidates through FTS and lightweight scoring.
  async recallLayered(
    query: string,
    limit = 5,
    layers: MemoryLayer[] = ["atom", "scenario", "artifact"],
  ): Promise<LayeredMemoryRecall> {
    const candidates = this.searchLayered(query, Math.max(30, limit), layers);
    const profiles = await this.listProfiles();
    return {
      atoms: candidates.filter((item) => item.layer === "atom").slice(0, limit),
      scenarios: candidates
        .filter((item) => item.layer === "scenario")
        .slice(0, limit),
      artifacts: candidates
        .filter((item) => item.layer === "artifact")
        .slice(0, limit),
      profiles,
    };
  }

  // Applies semantic scores from an embedding provider to already recalled candidates.
  async applySemanticScores(
    items: LayeredMemoryItem[],
    semanticScores: Map<string, number>,
  ): Promise<LayeredMemoryItem[]> {
    return items
      .map((item) => {
        const semantic = semanticScores.get(item.id) ?? 0;
        const score = {
          ...item.score,
          semantic,
          total:
            item.score.keyword * 0.5 +
            semantic * 0.3 +
            item.score.recency * 0.1 +
            item.score.confidence * 0.05 +
            item.score.freshness * 0.05,
        };
        return { ...item, score };
      })
      .sort(
        (left, right) =>
          right.score.total - left.score.total ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  // Retrieves active L1 atom records for legacy recall.
  private async recallAtoms(
    query: string,
    limit: number,
  ): Promise<StoredMemoryAtom[]> {
    const itemIds = this.searchLayered(query, limit, ["atom"]).map(
      (item) => item.id,
    );
    if (itemIds.length === 0) {
      return [];
    }
    return itemIds.flatMap((id) => {
      const row = this.database
        .connection()
        .prepare(
          "SELECT * FROM memory_atoms WHERE id = ? AND deleted_at IS NULL",
        )
        .get(id) as MemoryAtomRow | null | undefined;
      return row == null ? [] : [mapMemoryAtom(row)];
    });
  }

  // Inserts or replaces one item in the FTS recall index.
  private indexSearchItem(input: {
    id: string;
    layer: MemoryLayer;
    scope: string;
    content: string;
    sourceId: string | null;
    updatedAt: string;
  }): void {
    this.database
      .connection()
      .prepare("DELETE FROM memory_search_fts WHERE id = ?")
      .run(input.id);
    this.database
      .connection()
      .prepare(
        `INSERT INTO memory_search_fts
          (id, layer, scope, content, source_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.layer,
        input.scope,
        input.content,
        input.sourceId,
        input.updatedAt,
      );
  }

  // Marks a legacy-backed L1 atom deleted and removes it from FTS recall.
  private deleteAtomByLegacyMemoryId(legacyMemoryId: string): void {
    const now = currentTimestamp();
    const rows = this.database
      .connection()
      .prepare("SELECT id FROM memory_atoms WHERE legacy_memory_id = ?")
      .all(legacyMemoryId) as Array<{ id: string }>;
    this.database
      .connection()
      .prepare(
        "UPDATE memory_atoms SET deleted_at = ?, updated_at = ? WHERE legacy_memory_id = ?",
      )
      .run(now, now, legacyMemoryId);
    for (const row of rows) {
      this.database
        .connection()
        .prepare("DELETE FROM memory_search_fts WHERE id = ?")
        .run(row.id);
    }
  }

  // Searches the FTS index and falls back to deterministic overlap scoring when needed.
  private searchLayered(
    query: string,
    limit: number,
    layers: MemoryLayer[],
  ): LayeredMemoryItem[] {
    const queryTerms = memoryTerms(query);
    if (queryTerms.size === 0) {
      return [];
    }
    const ftsQuery = [...queryTerms].map((term) => `${term}*`).join(" OR ");
    const placeholders = layers.map(() => "?").join(", ");
    try {
      const rows = this.database
        .connection()
        .prepare(
          `SELECT id, layer, scope, content, source_id, updated_at, bm25(memory_search_fts) AS rank
             FROM memory_search_fts
            WHERE memory_search_fts MATCH ?
              AND layer IN (${placeholders})
            ORDER BY rank ASC
            LIMIT ?`,
        )
        .all(ftsQuery, ...layers, limit) as MemorySearchRow[];
      return rows.map((row) => mapSearchRow(row, queryTerms));
    } catch {
      return this.searchLayeredByOverlap(queryTerms, limit, layers);
    }
  }

  // Provides deterministic non-FTS fallback recall for unusual queries or builds.
  private searchLayeredByOverlap(
    queryTerms: Set<string>,
    limit: number,
    layers: MemoryLayer[],
  ): LayeredMemoryItem[] {
    const rows = this.database
      .connection()
      .prepare("SELECT * FROM memory_search_fts")
      .all() as MemorySearchRow[];
    return rows
      .filter((row) => layers.includes(row.layer))
      .map((row) => mapSearchRow(row, queryTerms))
      .filter((item) => item.score.keyword > 0)
      .sort(
        (left, right) =>
          right.score.total - left.score.total ||
          right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, limit);
  }
}

type MemoryServiceFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type MemoryEmbeddingProviderInput = {
  text: string;
  model: string;
  provider: string;
  environment: Record<string, string | undefined>;
};

export type MemoryEmbeddingProvider = (
  input: MemoryEmbeddingProviderInput,
) => Promise<number[] | null>;

export type MemoryServiceOptions = {
  database: KodeksDatabase;
  workspaceRoot: string;
  environment?: Record<string, string | undefined>;
  fetch?: MemoryServiceFetch;
  embeddingProvider?: MemoryEmbeddingProvider;
  artifactThresholdBytes?: number;
};

// Builds layered memory context, local embedding reranks, and large tool-result artifacts.
export class MemoryService {
  private readonly environment: Record<string, string | undefined>;
  private readonly fetchClient: MemoryServiceFetch | undefined;
  private readonly embeddingProvider: MemoryEmbeddingProvider | undefined;
  private readonly artifactThresholdBytes: number;

  // Wires memory services to the workspace root without taking a dependency on workspace package types.
  constructor(private readonly options: MemoryServiceOptions) {
    this.environment = options.environment ?? process.env;
    this.fetchClient = options.fetch ?? globalThis.fetch;
    this.embeddingProvider = options.embeddingProvider;
    this.artifactThresholdBytes = options.artifactThresholdBytes ?? 4096;
  }

  // Builds the compact memory context injected into the next model turn.
  async buildContext(input: {
    sessionId: string;
    query: string;
    limit?: number;
  }): Promise<MemoryContext> {
    const recall = await this.options.database.memories.recallLayered(
      input.query,
      input.limit ?? 5,
    );
    const recalledItems = [
      ...recall.atoms,
      ...recall.scenarios,
      ...recall.artifacts,
    ];
    const rerankedItems = await this.rerankWithEmbeddings(
      input.query,
      recalledItems,
    );
    const artifactRefs = (
      await Promise.all(
        rerankedItems
          .filter((item) => item.layer === "artifact" && item.sourceId !== null)
          .map((item) =>
            this.options.database.memories.getArtifactByRef(
              item.sourceId ?? "",
            ),
          ),
      )
    ).filter((artifact): artifact is StoredMemoryArtifact => artifact !== null);
    return {
      profiles: recall.profiles,
      recalledItems: rerankedItems.slice(0, input.limit ?? 5),
      artifactRefs,
    };
  }

  // Records one L0 user event and keeps extraction explicit and auditable.
  async recordUserInput(input: {
    sessionId: string;
    content: string;
  }): Promise<void> {
    await this.options.database.memories.recordEvent({
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      eventType: "turn_input",
    });
  }

  // Offloads oversized tool outputs to a workspace artifact and returns compact model-facing output.
  async compactToolResult(input: {
    sessionId: string;
    toolCallId: string | null;
    toolName: string;
    output: string;
  }): Promise<string> {
    const byteLength = Buffer.byteLength(input.output, "utf8");
    if (byteLength <= this.artifactThresholdBytes) {
      return input.output;
    }
    const contentHash = hashText(input.output);
    const refId = `memref_${contentHash.slice(0, 16)}`;
    const artifactDirectory = join(
      this.options.workspaceRoot,
      ".kodeks",
      "memory-artifacts",
    );
    await mkdir(artifactDirectory, { recursive: true });
    const filePath = join(artifactDirectory, `${refId}.md`);
    const summary = summarizeArtifactOutput(input.toolName, input.output);
    await writeFile(
      filePath,
      [
        `# ${input.toolName} tool result`,
        "",
        `- ref: ${refId}`,
        `- session: ${input.sessionId}`,
        `- toolCall: ${input.toolCallId ?? "unknown"}`,
        `- bytes: ${byteLength}`,
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Full Output",
        "",
        input.output,
      ].join("\n"),
      "utf8",
    );
    const artifact = await this.options.database.memories.rememberArtifact({
      refId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      summary,
      filePath,
      byteLength,
      contentHash,
    });
    return JSON.stringify({
      ok: true,
      offloaded: true,
      refId: artifact.refId,
      toolName: artifact.toolName,
      summary: artifact.summary,
      byteLength: artifact.byteLength,
      message:
        "Large tool output was stored as a memory artifact. Use read_memory_artifact with refId to inspect the full output.",
    });
  }

  // Adds local semantic scores from the configured embedding provider when reachable.
  private async rerankWithEmbeddings(
    query: string,
    items: LayeredMemoryItem[],
  ): Promise<LayeredMemoryItem[]> {
    if (!this.embeddingsEnabled() || items.length === 0) {
      return items;
    }
    const queryEmbedding = await this.embedText(query);
    if (queryEmbedding === null) {
      return items;
    }
    const scores = new Map<string, number>();
    for (const item of items) {
      const itemEmbedding = await this.embedText(item.content);
      if (itemEmbedding !== null) {
        scores.set(item.id, cosineSimilarity(queryEmbedding, itemEmbedding));
      }
    }
    if (scores.size === 0) {
      return items;
    }
    return this.options.database.memories.applySemanticScores(items, scores);
  }

  // Returns true when embedding rerank is explicitly enabled.
  private embeddingsEnabled(): boolean {
    return (
      this.environment.KODEKS_EMBEDDINGS_ENABLED === "true" &&
      this.resolveEmbeddingConfig() !== null
    );
  }

  // Embeds one text through the selected provider, using the SQLite cache first.
  private async embedText(text: string): Promise<number[] | null> {
    const config = this.resolveEmbeddingConfig();
    if (config === null) {
      return null;
    }
    const contentHash = hashText(`${config.cacheModel}\n${text}`);
    const cached = await this.options.database.memories.getEmbedding(
      contentHash,
      config.cacheModel,
    );
    if (cached !== null) {
      return cached;
    }
    const vector = await this.fetchEmbedding(text, config);
    if (vector === null) {
      return null;
    }
    await this.options.database.memories.rememberEmbedding({
      contentHash,
      embeddingModel: config.cacheModel,
      vector,
    });
    return vector;
  }

  // Resolves provider-specific model names while keeping local embeddings as the safe default.
  private resolveEmbeddingConfig(): {
    provider: string;
    model: string;
    cacheModel: string;
  } | null {
    const provider = (
      this.environment.KODEKS_EMBEDDINGS_PROVIDER ?? "local"
    ).toLowerCase();
    if (["disabled", "none", "off", "false"].includes(provider)) {
      return null;
    }
    const model =
      provider === "ollama"
        ? (this.environment.KODEKS_OLLAMA_EMBED_MODEL ?? "embeddinggemma")
        : provider === "lmstudio" ||
            provider === "lm-studio" ||
            provider === "openai-compatible" ||
            provider === "openai"
          ? (this.environment.KODEKS_LMSTUDIO_EMBED_MODEL ??
            this.environment.KODEKS_OPENAI_COMPAT_EMBED_MODEL ??
            "Qwen/Qwen3-Embedding-0.6B")
          : provider === "huggingface" || provider === "hf"
            ? (this.environment.KODEKS_HUGGINGFACE_EMBED_MODEL ??
              this.environment.KODEKS_HF_EMBED_MODEL ??
              "ibm-granite/granite-embedding-97m-multilingual-r2")
            : (this.environment.KODEKS_LOCAL_EMBED_MODEL ?? "local-hash-v1");
    return {
      provider,
      model,
      cacheModel: `${provider}:${model}`,
    };
  }

  // Dispatches embedding generation to the injected, local, Ollama, or Hugging Face provider.
  private async fetchEmbedding(
    text: string,
    config: { provider: string; model: string },
  ): Promise<number[] | null> {
    if (this.embeddingProvider !== undefined) {
      return this.embeddingProvider({
        text,
        model: config.model,
        provider: config.provider,
        environment: this.environment,
      });
    }
    if (config.provider === "local") {
      return createLocalHashEmbedding(text);
    }
    if (config.provider === "ollama") {
      return this.fetchOllamaEmbedding(text, config.model);
    }
    if (
      config.provider === "lmstudio" ||
      config.provider === "lm-studio" ||
      config.provider === "openai-compatible" ||
      config.provider === "openai"
    ) {
      return this.fetchOpenAICompatibleEmbedding(text, config.model);
    }
    if (config.provider === "huggingface" || config.provider === "hf") {
      return this.fetchHuggingFaceEmbedding(text, config.model);
    }
    return null;
  }

  // Embeds one text through Ollama's local /api/embed endpoint.
  private async fetchOllamaEmbedding(
    text: string,
    model: string,
  ): Promise<number[] | null> {
    if (this.fetchClient === undefined) {
      return null;
    }
    const baseUrl =
      this.environment.KODEKS_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    try {
      const response = await this.fetchClient(`${baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: text }),
      });
      if (!response.ok) {
        return null;
      }
      const vector = readOllamaEmbedding(await response.json());
      if (vector === null) {
        return null;
      }
      return vector;
    } catch {
      return null;
    }
  }

  // Embeds one text through an OpenAI-compatible /v1/embeddings endpoint such as LM Studio.
  private async fetchOpenAICompatibleEmbedding(
    text: string,
    model: string,
  ): Promise<number[] | null> {
    if (this.fetchClient === undefined) {
      return null;
    }
    const baseUrl = trimTrailingSlash(
      this.environment.KODEKS_LMSTUDIO_BASE_URL ??
        this.environment.KODEKS_OPENAI_COMPAT_BASE_URL ??
        "http://127.0.0.1:1234/v1",
    );
    const apiKey =
      this.environment.KODEKS_LMSTUDIO_API_KEY ??
      this.environment.KODEKS_OPENAI_COMPAT_API_KEY;
    try {
      const response = await this.fetchClient(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey === undefined
            ? {}
            : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model,
          input: text,
          encoding_format: "float",
        }),
      });
      if (!response.ok) {
        return null;
      }
      return readOpenAICompatibleEmbedding(await response.json());
    } catch {
      return null;
    }
  }

  // Embeds one text through a Hugging Face feature-extraction compatible endpoint.
  private async fetchHuggingFaceEmbedding(
    text: string,
    model: string,
  ): Promise<number[] | null> {
    if (this.fetchClient === undefined) {
      return null;
    }
    const endpoint =
      this.environment.KODEKS_HUGGINGFACE_EMBED_URL ??
      `${trimTrailingSlash(
        this.environment.KODEKS_HUGGINGFACE_BASE_URL ??
          "https://api-inference.huggingface.co",
      )}/pipeline/feature-extraction/${model}`;
    const token =
      this.environment.KODEKS_HUGGINGFACE_API_TOKEN ??
      this.environment.KODEKS_HF_API_TOKEN ??
      this.environment.HF_TOKEN;
    try {
      const response = await this.fetchClient(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ inputs: text, normalize: true, truncate: true }),
      });
      if (!response.ok) {
        return null;
      }
      return readHuggingFaceEmbedding(await response.json());
    } catch {
      return null;
    }
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
      decidedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO approvals
          (id, session_id, tool_call_id, command_json, status, reason, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.toolCallId,
        JSON.stringify(approval.command),
        approval.status,
        approval.reason,
        approval.createdAt,
        approval.decidedAt,
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
    this.database
      .connection()
      .prepare("UPDATE approvals SET reason = ? WHERE id = ?")
      .run(reason, id);
    return {
      ...approval,
      reason,
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
      .prepare(
        "UPDATE approvals SET status = 'executed', decided_at = ? WHERE id = ?",
      )
      .run(decidedAt, id);
    return {
      ...approval,
      status: "executed",
      decidedAt,
    };
  }

  // Resolves one pending approval while preventing double decisions.
  private async resolve(
    id: string,
    status: "approved" | "rejected",
  ): Promise<StoredApproval> {
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
      decidedAt,
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
      completedAt: null,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO subagent_runs
          (id, parent_session_id, agent_name, task, summary, status, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.parentSessionId,
        run.agentName,
        run.task,
        run.summary,
        run.status,
        run.createdAt,
        run.completedAt,
      );
    return run;
  }

  // Completes one running subagent with a compact summary.
  async completeRun(id: string, summary: string): Promise<StoredSubagentRun> {
    const completedAt = currentTimestamp();
    this.database
      .connection()
      .prepare(
        "UPDATE subagent_runs SET summary = ?, status = 'completed', completed_at = ? WHERE id = ?",
      )
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

export class PlanRepository {
  // Stores one durable active planning artifact per session for resume.
  constructor(private readonly database: KodeksDatabase) {}

  // Creates a new active plan and archives older active plans in the same session.
  async upsertActive(input: {
    sessionId: string;
    title: string;
    summary: string;
    steps: StoredPlanStep[];
    sourceMessageId?: string | null;
  }): Promise<StoredPlanArtifact> {
    const now = currentTimestamp();
    this.database
      .connection()
      .prepare(
        "UPDATE plan_artifacts SET status = 'archived', updated_at = ? WHERE session_id = ? AND status = 'active'",
      )
      .run(now, input.sessionId);

    const plan: StoredPlanArtifact = {
      id: prefixedId("plan"),
      sessionId: input.sessionId,
      title: input.title.trim() || "Plan",
      summary: input.summary.trim(),
      steps: input.steps,
      status: "active",
      sourceMessageId: input.sourceMessageId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO plan_artifacts
          (id, session_id, title, summary, steps_json, status, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.sessionId,
        plan.title,
        plan.summary,
        JSON.stringify(plan.steps),
        plan.status,
        plan.sourceMessageId,
        plan.createdAt,
        plan.updatedAt,
      );
    return plan;
  }

  // Returns the latest active plan artifact for a session, if one exists.
  async getActiveBySession(
    sessionId: string,
  ): Promise<StoredPlanArtifact | null> {
    const row = this.database
      .connection()
      .prepare(
        "SELECT * FROM plan_artifacts WHERE session_id = ? AND status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as PlanArtifactRow | null | undefined;
    return row == null ? null : mapPlanArtifact(row);
  }

  // Lists every plan artifact in newest-first order for session recovery screens.
  async listBySession(sessionId: string): Promise<StoredPlanArtifact[]> {
    const rows = this.database
      .connection()
      .prepare(
        "SELECT * FROM plan_artifacts WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC",
      )
      .all(sessionId) as PlanArtifactRow[];
    return rows.map(mapPlanArtifact);
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
      createdAt: currentTimestamp(),
    };
    this.database
      .connection()
      .prepare(
        `INSERT INTO audit_log
          (id, session_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sessionId,
        entry.eventType,
        JSON.stringify(entry.payload),
        entry.createdAt,
      );
    return entry;
  }

  // Lists audit events for one session in insertion order.
  async listBySession(sessionId: string): Promise<StoredAuditLogEntry[]> {
    const rows = this.database
      .connection()
      .prepare(
        "SELECT * FROM audit_log WHERE session_id = ? ORDER BY created_at ASC, id ASC",
      )
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

type MemoryAtomRow = {
  id: string;
  scope: string;
  content: string;
  source_session_id: string | null;
  confidence: number;
  freshness: number;
  legacy_memory_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type MemoryProfileRow = {
  id: string;
  scope: string;
  content: string;
  priority: number;
  source_session_id: string | null;
  confidence: number;
  freshness: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type MemoryArtifactRow = {
  id: string;
  ref_id: string;
  session_id: string | null;
  tool_call_id: string | null;
  tool_name: string;
  summary: string;
  file_path: string;
  byte_length: number;
  content_hash: string;
  created_at: string;
  deleted_at: string | null;
};

type MemoryEmbeddingRow = {
  content_hash: string;
  embedding_model: string;
  dimensions: number;
  vector_blob: Uint8Array;
  updated_at: string;
};

type MemorySearchRow = {
  id: string;
  layer: MemoryLayer;
  scope: string;
  content: string;
  source_id: string | null;
  updated_at: string;
  rank?: number;
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

type PlanArtifactRow = {
  id: string;
  session_id: string;
  title: string;
  summary: string;
  steps_json: string;
  status: StoredPlanArtifact["status"];
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
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
    archivedAt: row.archived_at,
  };
}

// Maps SQLite message rows into parsed transcript messages.
function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: JSON.parse(row.content_json) as unknown,
    agentEvent:
      row.agent_event_json === null
        ? null
        : (JSON.parse(row.agent_event_json) as unknown),
    createdAt: row.created_at,
  };
}

// Maps SQLite L1 atom rows into layered memory domain objects.
function mapMemoryAtom(row: MemoryAtomRow): StoredMemoryAtom {
  return {
    id: row.id,
    scope: row.scope,
    content: row.content,
    sourceSessionId: row.source_session_id,
    confidence: row.confidence,
    freshness: row.freshness,
    legacyMemoryId: row.legacy_memory_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// Maps SQLite L3 profile rows into layered memory domain objects.
function mapMemoryProfile(row: MemoryProfileRow): StoredMemoryProfile {
  return {
    id: row.id,
    scope: row.scope,
    content: row.content,
    priority: row.priority,
    sourceSessionId: row.source_session_id,
    confidence: row.confidence,
    freshness: row.freshness,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

// Maps artifact metadata rows into readable memory artifact objects.
function mapMemoryArtifact(row: MemoryArtifactRow): StoredMemoryArtifact {
  return {
    id: row.id,
    refId: row.ref_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    summary: row.summary,
    filePath: row.file_path,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
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
    decidedAt: row.decided_at,
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
    completedAt: row.completed_at,
  };
}

// Maps SQLite plan artifact rows into structured plan domain objects.
function mapPlanArtifact(row: PlanArtifactRow): StoredPlanArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    steps: readStoredPlanSteps(row.steps_json),
    status: row.status,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Maps SQLite audit rows into parsed audit event objects.
function mapAuditLogEntry(row: AuditLogRow): StoredAuditLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
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

// Parses persisted plan steps while tolerating older or malformed rows.
function readStoredPlanSteps(value: string): StoredPlanStep[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.title !== "string") {
      return [];
    }
    return [
      {
        id: record.id,
        title: record.title,
        status: readPlanStepStatus(record.status),
        details: typeof record.details === "string" ? record.details : null,
      },
    ];
  });
}

// Normalizes plan step status strings from persisted JSON.
function readPlanStepStatus(value: unknown): PlanStepStatus {
  return value === "in_progress" || value === "completed" ? value : "pending";
}

// Extracts lightweight recall terms for the MVP memory scorer.
function memoryTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9_\u4e00-\u9fff]+/gu)
      ?.filter((term) => term.length > 1) ?? [],
  );
}

// Counts how many query terms are present in a memory record.
function overlapScore(
  queryTerms: Set<string>,
  contentTerms: Set<string>,
): number {
  let score = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) {
      score += 1;
    }
  }
  return score;
}

// Maps one FTS row into a shared recall item with explainable component scores.
function mapSearchRow(
  row: MemorySearchRow,
  queryTerms: Set<string>,
): LayeredMemoryItem {
  const keyword =
    row.rank === undefined
      ? overlapScore(queryTerms, memoryTerms(row.content))
      : 1 / (1 + Math.abs(row.rank));
  const recency = recencyScore(row.updated_at);
  const score = {
    keyword,
    semantic: 0,
    recency,
    confidence: 1,
    freshness: 1,
    total: keyword * 0.7 + recency * 0.2 + 0.1,
  };
  return {
    id: row.id,
    layer: row.layer,
    scope: row.scope,
    content: row.content,
    sourceId: row.source_id,
    updatedAt: row.updated_at,
    score,
  };
}

// Gives recently updated memory a small deterministic boost without dominating relevance.
function recencyScore(timestamp: string): number {
  const ageMs = Math.max(0, Date.now() - Date.parse(timestamp));
  const dayMs = 24 * 60 * 60 * 1000;
  return 1 / (1 + ageMs / (30 * dayMs));
}

// Hashes text for stable artifact refs and embedding cache keys.
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
