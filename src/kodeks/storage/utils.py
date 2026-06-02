"""Shared SQLite storage mapping and id helpers."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Protocol
from uuid import uuid4

from ..contracts import StoredApproval, StoredMessage, StoredPlanArtifact, StoredSession


class HasConnection(Protocol):
    """Storage repository dependency exposing one SQLite connection."""

    connection: sqlite3.Connection


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
