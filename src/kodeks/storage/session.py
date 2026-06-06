"""SQLite repositories for sessions and control artifacts."""

from __future__ import annotations

import json
from typing import Any

from ..contracts import (
    AuditEventType,
    StoredApproval,
    StoredMessage,
    StoredPlanArtifact,
    StoredSession,
)
from .utils import (
    HasConnection,
    current_timestamp,
    map_approval,
    map_message,
    map_plan,
    map_session,
    prefixed_id,
)


class ApprovalNotFoundError(RuntimeError):
    """Raised when an approval id does not exist."""


class ApprovalAlreadyResolvedError(RuntimeError):
    """Raised when a pending-only approval action is repeated."""


class SessionRepository:
    """Stores multi-session metadata and transcript messages."""

    def __init__(self, database: HasConnection) -> None:
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


class ApprovalRepository:
    """Stores approval records for dangerous command execution."""

    def __init__(self, database: HasConnection) -> None:
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
        """Move one pending approval into its final user decision state."""

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
    """Reads and writes active plan artifacts for session recovery."""

    def __init__(self, database: HasConnection) -> None:
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

    def __init__(self, database: HasConnection) -> None:
        self.database = database

    def record(
        self, session_id: str | None, event_type: AuditEventType, payload: Any
    ) -> None:
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
