"""SQLite repositories for memory artifacts and subagent run records."""

from __future__ import annotations

import json
from hashlib import sha256
from pathlib import Path
from typing import Any

from .utils import HasConnection, current_timestamp, prefixed_id


class MemoryRepository:
    """Stores and recalls the minimal memory records used by tools."""

    def __init__(self, database: HasConnection) -> None:
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
              (id, scope, content, source_session_id, confidence, freshness, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                prefixed_id("atom"),
                scope,
                content,
                source_session_id,
                1.0,
                1.0,
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
        """Recall the bounded fact and artifact layers used by the harness."""

        return {
            "atoms": self._recall_layer("memory_atoms", query, limit)
            if "atom" in layers
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
        """Recall one literal-search memory table."""

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

    def _recall_artifacts(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Recall offloaded memory artifact metadata by summary."""

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
    """Stores bounded subagent exploration run records."""

    def __init__(self, database: HasConnection) -> None:
        self.database = database

    def start_run(
        self, parent_session_id: str, agent_name: str, task: str
    ) -> dict[str, Any]:
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


def summarize_artifact_output(tool_name: str, output: str) -> str:
    """Build a compact summary for an offloaded tool result."""

    lines = [line.strip() for line in output.splitlines() if line.strip()]
    preview = " ".join(lines[:6]) if lines else output.strip()
    if len(preview) > 240:
        preview = preview[:239].rstrip()
    return preview or f"Large {tool_name} output"
