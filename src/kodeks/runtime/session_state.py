# q1: Phase 4 用 SQLite 保存 session state 合理吗？
# a1: 合理。SQLite 让 session_id -> previous_response_id 能跨进程重启保留，更接近真实业务里的 multi-session/resume 需求；关键是把 SQLite 细节隔离在 store adapter 后面。
# q2: 为什么还保留 InMemorySessionStateStore？
# a2: 内存 store 适合单测和轻量替换。runtime 依赖的是 SessionStateStore 协议，不关心底层是 dict、SQLite，还是未来的远端数据库。

import sqlite3
from pathlib import Path
from typing import Protocol

from kodeks.core.config import SESSION_STATE_DB_PATH


class SessionStateStore(Protocol):
    """Store the latest model response ID for each kodeks session."""

    def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

    def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

    def clear(self, session_id: str) -> None:
        """Forget state for one session."""


class InMemorySessionStateStore:
    """In-process session state for tests and lightweight local injection."""

    def __init__(self) -> None:
        self._previous_response_ids: dict[str, str] = {}

    def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

        return self._previous_response_ids.get(session_id)

    def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

        self._previous_response_ids[session_id] = response_id

    def clear(self, session_id: str) -> None:
        """Forget state for one session."""

        self._previous_response_ids.pop(session_id, None)


class SQLiteSessionStateStore:
    """Persistent session state backed by a local SQLite database."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._db_path = Path(db_path) if db_path is not None else SESSION_STATE_DB_PATH
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        """Open a short-lived SQLite connection for one store operation."""

        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        return sqlite3.connect(self._db_path)

    def _ensure_schema(self) -> None:
        """Create the session state table if this is the first process run."""

        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS session_state (
                    session_id TEXT PRIMARY KEY,
                    previous_response_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT previous_response_id
                FROM session_state
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()

        if row is None:
            return None

        return str(row[0])

    def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO session_state (session_id, previous_response_id, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(session_id) DO UPDATE SET
                    previous_response_id = excluded.previous_response_id,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (session_id, response_id),
            )

    def clear(self, session_id: str) -> None:
        """Forget state for one session."""

        with self._connect() as connection:
            connection.execute(
                "DELETE FROM session_state WHERE session_id = ?",
                (session_id,),
            )
