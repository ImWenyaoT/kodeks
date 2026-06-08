// frontend/lib/server/storage/schema.ts
// 存储层 schema：逐字节忠实移植自 Python src/kodeks/storage/db.py:100-196。
// 10 张 CREATE TABLE（无任何 CREATE INDEX）；schema_version 标记常量；表名清单。
//
// 保真红线（见 .remember/migration-specs/40-storage.md §1、保真风险 10）：
//  · SQL 文本逐字保留（表名/列名/列类型 TEXT|REAL|INTEGER/约束/UNIQUE）。
//  · 全部为 CREATE TABLE IF NOT EXISTS；不加任何索引（保真基线）。
//  · 表数量是 10 张（不是编排说明声称的 11）。

/** 当前 schema 版本标记（移植 db.py:31 CURRENT_SCHEMA_VERSION = 1）。 */
export const CURRENT_SCHEMA_VERSION = 1

/**
 * 完整 schema SQL（逐字移植 db.py:100-196 的 SCHEMA_SQL）。
 * 用 executeMultiple 一次性执行（对应 Python executescript）。
 */
export const SCHEMA_SQL = `
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
CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS memory_atoms (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  content TEXT NOT NULL,
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
`

/** 全部 10 张表名清单（顺序与 SCHEMA_SQL 一致，仅作校验/枚举用途）。 */
export const SCHEMA_TABLE_NAMES = [
  'sessions',
  'schema_metadata',
  'messages',
  'memories',
  'memory_atoms',
  'memory_artifacts',
  'approvals',
  'subagent_runs',
  'plan_artifacts',
  'audit_log',
] as const

/** 表名联合类型。 */
export type SchemaTableName = (typeof SCHEMA_TABLE_NAMES)[number]
