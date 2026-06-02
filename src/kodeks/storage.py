"""SQLite repositories compatible with the current TypeScript schema."""

from __future__ import annotations

import json
import sqlite3
import time
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import uuid4

from .contracts import StoredApproval, StoredMessage, StoredPlanArtifact, StoredSession

CURRENT_SCHEMA_VERSION = 1


class ApprovalNotFoundError(RuntimeError):
    """Raised when an approval id does not exist."""


class ApprovalAlreadyResolvedError(RuntimeError):
    """Raised when a pending-only approval action is repeated."""


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
        """Create durable tables used by the TypeScript MVP."""

        self.connection.executescript(
            """
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
        )
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


class SessionRepository:
    """Stores multi-session metadata and transcript messages."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def create_session(
        self,
        title: str,
        mode: str,
        workspace_root: str,
        session_id: str | None = None,
        parent_session_id: str | None = None,
    ) -> StoredSession:
        """Create or replace one session record."""

        now = current_timestamp()
        session = StoredSession(
            id=session_id or prefixed_id("sess"),
            title=title,
            mode=mode,  # type: ignore[arg-type]
            workspaceRoot=workspace_root,
            parentSessionId=parent_session_id,
            createdAt=now,
            updatedAt=now,
            archivedAt=None,
        )
        self.database.connection.execute(
            """
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
            """,
            (
                session.id,
                session.title,
                session.mode,
                session.workspace_root,
                session.parent_session_id,
                session.created_at,
                session.updated_at,
                session.archived_at,
            ),
        )
        self.database.connection.commit()
        return session

    def get_session(self, session_id: str) -> StoredSession | None:
        """Return one session by id, or None."""

        row = self.database.connection.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return map_session(row) if row is not None else None

    def list_sessions(self) -> list[StoredSession]:
        """List non-archived sessions newest-first."""

        rows = self.database.connection.execute(
            "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC, id ASC"
        ).fetchall()
        return [map_session(row) for row in rows]

    def update_mode(self, session_id: str, mode: str) -> None:
        """Update the current session mode."""

        self.database.connection.execute(
            "UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?",
            (mode, current_timestamp(), session_id),
        )
        self.database.connection.commit()

    def append_message(
        self,
        session_id: str,
        role: str,
        content: Any,
        agent_event: Any | None = None,
    ) -> StoredMessage:
        """Append one transcript message or mapped agent event."""

        message = StoredMessage(
            id=prefixed_id("msg"),
            sessionId=session_id,
            role=role,
            content=content,
            agentEvent=agent_event,
            createdAt=current_timestamp(),
        )
        self.database.connection.execute(
            """
            INSERT INTO messages
              (id, session_id, role, content_json, agent_event_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                message.id,
                message.session_id,
                message.role,
                json.dumps(message.content),
                None
                if message.agent_event is None
                else json.dumps(message.agent_event),
                message.created_at,
            ),
        )
        self.database.connection.commit()
        return message

    def get_transcript(self, session_id: str) -> list[StoredMessage]:
        """Load transcript messages in insertion order."""

        rows = self.database.connection.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC",
            (session_id,),
        ).fetchall()
        return [map_message(row) for row in rows]

    def get_latest_assistant_response_id(self, session_id: str) -> str | None:
        """Read the newest persisted assistant response id for stateful APIs."""

        rows = self.database.connection.execute(
            """
            SELECT * FROM messages
            WHERE session_id = ? AND role = 'assistant'
            ORDER BY rowid DESC
            """,
            (session_id,),
        ).fetchall()
        for row in rows:
            content = json.loads(row["content_json"])
            if isinstance(content, dict) and isinstance(content.get("responseId"), str):
                return str(content["responseId"])
            if row["agent_event_json"] is not None:
                agent_event = json.loads(row["agent_event_json"])
                if isinstance(agent_event, dict) and isinstance(
                    agent_event.get("responseId"), str
                ):
                    return str(agent_event["responseId"])
        return None


class ApprovalRepository:
    """Stores approval records for dangerous command execution."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def create_approval(
        self,
        command: Any,
        reason: str,
        session_id: str | None = None,
        tool_call_id: str | None = None,
    ) -> StoredApproval:
        """Create one pending approval."""

        approval = StoredApproval(
            id=prefixed_id("appr"),
            sessionId=session_id,
            toolCallId=tool_call_id,
            command=command,
            status="pending",
            reason=reason,
            createdAt=current_timestamp(),
            decidedAt=None,
        )
        self.database.connection.execute(
            """
            INSERT INTO approvals
              (id, session_id, tool_call_id, command_json, status, reason, created_at, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                approval.id,
                approval.session_id,
                approval.tool_call_id,
                json.dumps(approval.command),
                approval.status,
                approval.reason,
                approval.created_at,
                approval.decided_at,
            ),
        )
        self.database.connection.commit()
        return approval

    def get_approval(self, approval_id: str) -> StoredApproval:
        """Return one approval or raise a stable not-found error."""

        row = self.database.connection.execute(
            "SELECT * FROM approvals WHERE id = ?", (approval_id,)
        ).fetchone()
        if row is None:
            raise ApprovalNotFoundError(f"Approval not found: {approval_id}")
        return map_approval(row)

    def approve(self, approval_id: str) -> StoredApproval:
        """Mark a pending approval as approved."""

        return self._resolve(approval_id, "approved", "approved")

    def reject(self, approval_id: str, reason: str) -> StoredApproval:
        """Mark a pending approval as rejected with a user reason."""

        approval = self.get_approval(approval_id)
        if approval.status != "pending":
            raise ApprovalAlreadyResolvedError(
                f"Approval already resolved: {approval_id}"
            )
        self.database.connection.execute(
            "UPDATE approvals SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ?",
            (reason, current_timestamp(), approval_id),
        )
        self.database.connection.commit()
        return self.get_approval(approval_id)

    def mark_executed(self, approval_id: str) -> StoredApproval:
        """Mark an approved command as executed once."""

        approval = self.get_approval(approval_id)
        if approval.status != "approved":
            raise ApprovalAlreadyResolvedError(
                f"Approval already resolved: {approval_id}"
            )
        self.database.connection.execute(
            "UPDATE approvals SET status = 'executed', decided_at = ? WHERE id = ?",
            (current_timestamp(), approval_id),
        )
        self.database.connection.commit()
        return self.get_approval(approval_id)

    def _resolve(self, approval_id: str, status: str, reason: str) -> StoredApproval:
        approval = self.get_approval(approval_id)
        if approval.status != "pending":
            raise ApprovalAlreadyResolvedError(
                f"Approval already resolved: {approval_id}"
            )
        self.database.connection.execute(
            "UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ?",
            (status, reason, current_timestamp(), approval_id),
        )
        self.database.connection.commit()
        return self.get_approval(approval_id)


class PlanRepository:
    """Reads and writes active plan artifacts for session compatibility."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def get_active_by_session(self, session_id: str) -> StoredPlanArtifact | None:
        """Return the newest active plan for a session."""

        row = self.database.connection.execute(
            """
            SELECT * FROM plan_artifacts
            WHERE session_id = ? AND status = 'active'
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
            """,
            (session_id,),
        ).fetchone()
        return map_plan(row) if row is not None else None

    def upsert_active(
        self,
        session_id: str,
        title: str,
        summary: str,
        steps: list[dict[str, Any]],
        source_message_id: str | None = None,
    ) -> StoredPlanArtifact:
        """Archive existing plans and create one active plan artifact."""

        now = current_timestamp()
        self.database.connection.execute(
            "UPDATE plan_artifacts SET status = 'archived', updated_at = ? WHERE session_id = ? AND status = 'active'",
            (now, session_id),
        )
        plan_id = prefixed_id("plan")
        self.database.connection.execute(
            """
            INSERT INTO plan_artifacts
              (id, session_id, title, summary, steps_json, status, source_message_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan_id,
                session_id,
                title,
                summary,
                json.dumps(steps),
                "active",
                source_message_id,
                now,
                now,
            ),
        )
        self.database.connection.commit()
        plan = self.get_active_by_session(session_id)
        if plan is None:
            raise RuntimeError(f"Plan artifact not found after insert: {plan_id}")
        return plan


class AuditLogRepository:
    """Records auditable backend actions."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def record(self, session_id: str | None, event_type: str, payload: Any) -> None:
        """Append one audit log entry."""

        self.database.connection.execute(
            """
            INSERT INTO audit_log (id, session_id, event_type, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                prefixed_id("aud"),
                session_id,
                event_type,
                json.dumps(payload),
                current_timestamp(),
            ),
        )
        self.database.connection.commit()


class MemoryRepository:
    """Stores and recalls the minimal memory records used by tools."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def remember(
        self, scope: str, content: str, source_session_id: str | None = None
    ) -> str:
        """Store one memory fact and mirror it into the atom layer."""

        now = current_timestamp()
        memory_id = prefixed_id("mem")
        self.database.connection.execute(
            """
            INSERT INTO memories
              (id, scope, content, source_session_id, confidence, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (memory_id, scope, content, source_session_id, 1.0, now, now, None),
        )
        self.database.connection.execute(
            """
            INSERT INTO memory_atoms
              (id, scope, content, source_session_id, confidence, freshness, legacy_memory_id, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                prefixed_id("atom"),
                scope,
                content,
                source_session_id,
                1.0,
                1.0,
                memory_id,
                now,
                now,
                None,
            ),
        )
        self.database.connection.commit()
        return memory_id

    def recall(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Recall simple memory rows by literal content match."""

        rows = self.database.connection.execute(
            """
            SELECT * FROM memories
            WHERE deleted_at IS NULL AND content LIKE ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?
            """,
            (f"%{query}%", limit),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "scope": row["scope"],
                "content": row["content"],
                "sourceSessionId": row["source_session_id"],
                "confidence": row["confidence"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def recall_layered(
        self, query: str, limit: int, layers: list[str]
    ) -> dict[str, list[dict[str, Any]]]:
        """Recall memory layers using the current MVP literal search."""

        return {
            "atoms": self._recall_layer("memory_atoms", query, limit)
            if "atom" in layers
            else [],
            "scenarios": self._recall_scenarios(query, limit)
            if "scenario" in layers
            else [],
            "artifacts": self._recall_artifacts(query, limit)
            if "artifact" in layers
            else [],
        }

    def read_artifact_content(self, ref_id: str) -> dict[str, Any] | None:
        """Read one offloaded memory artifact body by ref id."""

        row = self.database.connection.execute(
            "SELECT * FROM memory_artifacts WHERE ref_id = ? AND deleted_at IS NULL",
            (ref_id,),
        ).fetchone()
        if row is None:
            return None
        file_path = Path(row["file_path"])
        if not file_path.is_file():
            return None
        return {
            "artifact": {
                "id": row["id"],
                "refId": row["ref_id"],
                "sessionId": row["session_id"],
                "toolCallId": row["tool_call_id"],
                "toolName": row["tool_name"],
                "summary": row["summary"],
                "filePath": row["file_path"],
                "byteLength": row["byte_length"],
                "contentHash": row["content_hash"],
                "createdAt": row["created_at"],
            },
            "content": file_path.read_text(),
        }

    def compact_tool_result(
        self,
        workspace_root: str,
        session_id: str,
        tool_call_id: str | None,
        tool_name: str,
        output: str,
        threshold_bytes: int = 4096,
    ) -> str:
        """Offload oversized successful tool output into a memory artifact."""

        byte_length = len(output.encode("utf-8"))
        if byte_length <= threshold_bytes:
            return output
        content_hash = sha256(output.encode("utf-8")).hexdigest()
        ref_id = f"memref_{content_hash[:16]}"
        artifact_dir = Path(workspace_root) / ".kodeks" / "memory-artifacts"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        file_path = artifact_dir / f"{ref_id}.md"
        summary = summarize_artifact_output(tool_name, output)
        file_path.write_text(
            "\n".join(
                [
                    f"# {tool_name} tool result",
                    "",
                    f"- ref: {ref_id}",
                    f"- session: {session_id}",
                    f"- toolCall: {tool_call_id or 'unknown'}",
                    f"- bytes: {byte_length}",
                    "",
                    "## Summary",
                    "",
                    summary,
                    "",
                    "## Full Output",
                    "",
                    output,
                ]
            ),
        )
        artifact = self.remember_artifact(
            ref_id=ref_id,
            session_id=session_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            summary=summary,
            file_path=str(file_path),
            byte_length=byte_length,
            content_hash=content_hash,
        )
        return json.dumps(
            {
                "ok": True,
                "offloaded": True,
                "refId": artifact["refId"],
                "toolName": artifact["toolName"],
                "summary": artifact["summary"],
                "byteLength": artifact["byteLength"],
                "message": "Large tool output was stored as a memory artifact. Use read_memory_artifact with refId to inspect the full output.",
            },
            separators=(",", ":"),
        )

    def remember_artifact(
        self,
        ref_id: str,
        session_id: str | None,
        tool_call_id: str | None,
        tool_name: str,
        summary: str,
        file_path: str,
        byte_length: int,
        content_hash: str,
    ) -> dict[str, Any]:
        """Store metadata for one offloaded memory artifact."""

        artifact = {
            "id": prefixed_id("mart"),
            "refId": ref_id,
            "sessionId": session_id,
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "summary": summary,
            "filePath": file_path,
            "byteLength": byte_length,
            "contentHash": content_hash,
            "createdAt": current_timestamp(),
        }
        self.database.connection.execute(
            """
            INSERT INTO memory_artifacts
              (id, ref_id, session_id, tool_call_id, tool_name, summary, file_path, byte_length, content_hash, created_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                artifact["id"],
                artifact["refId"],
                artifact["sessionId"],
                artifact["toolCallId"],
                artifact["toolName"],
                artifact["summary"],
                artifact["filePath"],
                artifact["byteLength"],
                artifact["contentHash"],
                artifact["createdAt"],
            ),
        )
        self.database.connection.commit()
        return artifact

    def _recall_layer(
        self, table: str, query: str, limit: int
    ) -> list[dict[str, Any]]:
        rows = self.database.connection.execute(
            f"""
            SELECT * FROM {table}
            WHERE deleted_at IS NULL AND content LIKE ?
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?
            """,
            (f"%{query}%", limit),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "scope": row["scope"],
                "content": row["content"],
                "sourceSessionId": row["source_session_id"],
                "confidence": row["confidence"],
                "freshness": row["freshness"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def _recall_scenarios(self, query: str, limit: int) -> list[dict[str, Any]]:
        rows = self.database.connection.execute(
            """
            SELECT * FROM memory_scenarios
            WHERE deleted_at IS NULL AND (title LIKE ? OR summary LIKE ?)
            ORDER BY updated_at DESC, rowid DESC
            LIMIT ?
            """,
            (f"%{query}%", f"%{query}%", limit),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "scope": row["scope"],
                "title": row["title"],
                "summary": row["summary"],
                "sourceSessionId": row["source_session_id"],
                "confidence": row["confidence"],
                "freshness": row["freshness"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def _recall_artifacts(self, query: str, limit: int) -> list[dict[str, Any]]:
        rows = self.database.connection.execute(
            """
            SELECT * FROM memory_artifacts
            WHERE deleted_at IS NULL AND summary LIKE ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            (f"%{query}%", limit),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "refId": row["ref_id"],
                "toolName": row["tool_name"],
                "summary": row["summary"],
                "filePath": row["file_path"],
                "byteLength": row["byte_length"],
                "contentHash": row["content_hash"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]


class SubagentRepository:
    """Stores minimal subagent run records for tool parity."""

    def __init__(self, database: KodeksDatabase) -> None:
        self.database = database

    def start_run(self, parent_session_id: str, agent_name: str, task: str) -> dict[str, Any]:
        """Create one running subagent record."""

        run = {
            "id": prefixed_id("sub"),
            "parentSessionId": parent_session_id,
            "agentName": agent_name,
            "task": task,
            "summary": None,
            "status": "running",
            "createdAt": current_timestamp(),
            "completedAt": None,
        }
        self.database.connection.execute(
            """
            INSERT INTO subagent_runs
              (id, parent_session_id, agent_name, task, summary, status, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run["id"],
                run["parentSessionId"],
                run["agentName"],
                run["task"],
                run["summary"],
                run["status"],
                run["createdAt"],
                run["completedAt"],
            ),
        )
        self.database.connection.commit()
        return run

    def complete_run(self, run_id: str, summary: str) -> dict[str, Any]:
        """Mark one subagent run as completed."""

        completed_at = current_timestamp()
        self.database.connection.execute(
            """
            UPDATE subagent_runs
            SET summary = ?, status = 'completed', completed_at = ?
            WHERE id = ?
            """,
            (summary, completed_at, run_id),
        )
        self.database.connection.commit()
        run = self.get_run(run_id)
        if run is None:
            raise RuntimeError(f"Subagent run not found: {run_id}")
        return run

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        """Read one subagent run."""

        row = self.database.connection.execute(
            "SELECT * FROM subagent_runs WHERE id = ?", (run_id,)
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "parentSessionId": row["parent_session_id"],
            "agentName": row["agent_name"],
            "task": row["task"],
            "summary": row["summary"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "completedAt": row["completed_at"],
        }


def current_timestamp() -> str:
    """Return an ISO timestamp compatible with JavaScript `toISOString`."""

    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def prefixed_id(prefix: str) -> str:
    """Create a compact prefixed id compatible with existing TS ids."""

    return f"{prefix}_{uuid4().hex}"


def map_session(row: sqlite3.Row) -> StoredSession:
    """Map one SQLite row to a session contract."""

    return StoredSession(
        id=row["id"],
        title=row["title"],
        mode=row["mode"],
        workspaceRoot=row["workspace_root"],
        parentSessionId=row["parent_session_id"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
        archivedAt=row["archived_at"],
    )


def map_message(row: sqlite3.Row) -> StoredMessage:
    """Map one SQLite row to a transcript message contract."""

    return StoredMessage(
        id=row["id"],
        sessionId=row["session_id"],
        role=row["role"],
        content=json.loads(row["content_json"]),
        agentEvent=None
        if row["agent_event_json"] is None
        else json.loads(row["agent_event_json"]),
        createdAt=row["created_at"],
    )


def map_approval(row: sqlite3.Row) -> StoredApproval:
    """Map one SQLite row to an approval contract."""

    return StoredApproval(
        id=row["id"],
        sessionId=row["session_id"],
        toolCallId=row["tool_call_id"],
        command=json.loads(row["command_json"]),
        status=row["status"],
        reason=row["reason"],
        createdAt=row["created_at"],
        decidedAt=row["decided_at"],
    )


def map_plan(row: sqlite3.Row) -> StoredPlanArtifact:
    """Map one SQLite row to a plan artifact contract."""

    return StoredPlanArtifact(
        id=row["id"],
        sessionId=row["session_id"],
        title=row["title"],
        summary=row["summary"],
        steps=json.loads(row["steps_json"]),
        status=row["status"],
        sourceMessageId=row["source_message_id"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def summarize_artifact_output(tool_name: str, output: str) -> str:
    """Build a compact summary for an offloaded tool result."""

    lines = [line.strip() for line in output.splitlines() if line.strip()]
    preview = " ".join(lines[:6]) if lines else output.strip()
    if len(preview) > 240:
        preview = preview[:239].rstrip()
    return preview or f"Large {tool_name} output"
