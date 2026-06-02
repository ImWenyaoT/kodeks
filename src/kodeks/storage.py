"""SQLite database facade for the Python Kodeks service."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from .memory_storage import (
    MemoryRepository,
    SubagentRepository,
    summarize_artifact_output,
)
from .session_storage import (
    ApprovalAlreadyResolvedError,
    ApprovalNotFoundError,
    ApprovalRepository,
    AuditLogRepository,
    PlanRepository,
    SessionRepository,
)
from .storage_utils import (
    current_timestamp,
    map_approval,
    map_message,
    map_plan,
    map_session,
    prefixed_id,
)

CURRENT_SCHEMA_VERSION = 1


class KodeksDatabase:
    """Open a local SQLite database and expose domain repositories."""

    def __init__(self, path: str = ":memory:") -> None:
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.configure_connection()
        self.initialize_schema()
        self.sessions = SessionRepository(self)
        self.approvals = ApprovalRepository(self)
        self.plans = PlanRepository(self)
        self.audit_log = AuditLogRepository(self)
        self.memories = MemoryRepository(self)
        self.subagents = SubagentRepository(self)

    def close(self) -> None:
        """Close the underlying SQLite connection."""

        self.connection.close()

    def configure_connection(self) -> None:
        """Configure SQLite for shared FastAPI process and file DB access."""

        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.execute("PRAGMA foreign_keys = ON")
        if self.path != ":memory:":
            self.configure_wal_mode()

    def configure_wal_mode(self) -> None:
        """Enable WAL mode while tolerating startup races between connections."""

        for attempt in range(5):
            try:
                self.connection.execute("PRAGMA journal_mode = WAL")
                return
            except sqlite3.OperationalError as error:
                if "database is locked" not in str(error) or attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))

    def initialize_schema(self) -> None:
        """Create durable tables used by the Python service."""

        self.connection.executescript(SCHEMA_SQL)
        self.connection.execute(
            """
            INSERT INTO schema_metadata (key, value, updated_at)
            VALUES ('schema_version', ?, ?)
            ON CONFLICT(key) DO NOTHING
            """,
            (str(CURRENT_SCHEMA_VERSION), current_timestamp()),
        )
        self.connection.commit()

    def get_schema_version(self) -> int:
        """Read the current schema version marker."""

        row = self.connection.execute(
            "SELECT * FROM schema_metadata WHERE key = 'schema_version'"
        ).fetchone()
        return int(row["value"]) if row is not None else 0


SCHEMA_SQL = """
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
"""

__all__ = [
    "ApprovalAlreadyResolvedError",
    "ApprovalNotFoundError",
    "ApprovalRepository",
    "AuditLogRepository",
    "CURRENT_SCHEMA_VERSION",
    "KodeksDatabase",
    "MemoryRepository",
    "PlanRepository",
    "SessionRepository",
    "SubagentRepository",
    "current_timestamp",
    "map_approval",
    "map_message",
    "map_plan",
    "map_session",
    "prefixed_id",
    "summarize_artifact_output",
]
