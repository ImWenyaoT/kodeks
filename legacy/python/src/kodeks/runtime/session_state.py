# q1: Phase 4 用 SQLite 保存 session state 合理吗？
# a1: 合理。SQLite 让 session transcript 和 latest completion id 能跨进程重启保留，更接近真实业务里的 multi-session/resume 需求；关键是把 SQLite 细节隔离在 store adapter 后面。
# q2: 为什么还保留 InMemorySessionStateStore？
# a2: 内存 store 适合单测和轻量替换。runtime 依赖的是 SessionStateStore 协议，不关心底层是 dict、SQLite，还是未来的远端数据库。
# q3: 这和 /src、opencode 的 multi-session/resume 有什么关系？
# a3: 当前只是最小 conversation state。后续要参考 /src 的 transcript/resume/session storage 设计，并用 opencode 的 session/v2/session 结构做对照，逐步扩成真正的 session 层。

import asyncio
import sqlite3
import threading
from pathlib import Path
from typing import Protocol

from kodeks.core.config import SESSION_STATE_DB_PATH


class SessionStateStore(Protocol):
    """Store transcript and compatibility completion state for each session."""

    async def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

    async def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

    async def clear(self, session_id: str) -> None:
        """Forget state for one session."""

    async def append_transcript_event(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append one minimal transcript event for a session."""

    async def get_transcript(self, session_id: str) -> list[dict[str, str]]:
        """Return transcript events for one session in insertion order."""


class InMemorySessionStateStore:
    """In-process session state for tests and lightweight local injection."""

    def __init__(self) -> None:
        self._previous_response_ids: dict[str, str] = {}
        self._transcripts: dict[str, list[dict[str, str]]] = {}

    async def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

        return self._previous_response_ids.get(session_id)

    async def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

        self._previous_response_ids[session_id] = response_id

    async def clear(self, session_id: str) -> None:
        """Forget state for one session."""

        self._previous_response_ids.pop(session_id, None)
        self._transcripts.pop(session_id, None)

    async def append_transcript_event(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append one minimal transcript event for a session."""

        self._transcripts.setdefault(session_id, []).append(
            {"role": role, "content": content}
        )

    async def get_transcript(self, session_id: str) -> list[dict[str, str]]:
        """Return transcript events for one session in insertion order."""

        return list(self._transcripts.get(session_id, []))


class SQLiteSessionStateStore:
    """Persistent session state backed by a local SQLite database."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._db_path = Path(db_path) if db_path is not None else SESSION_STATE_DB_PATH
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()
        self._connection: sqlite3.Connection | None = None
        self._connection_lock = threading.RLock()

    def _connect(self) -> sqlite3.Connection:
        """Return the store's cached SQLite connection."""

        if self._connection is None:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(
                self._db_path,
                check_same_thread=False,
            )
        return self._connection

    def _ensure_schema_sync(self) -> None:
        """Create the session state table if this is the first process run."""

        with self._connection_lock:
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
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS session_transcript (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        session_id TEXT NOT NULL,
                        role TEXT NOT NULL,
                        content TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )

    async def _ensure_schema(self) -> None:
        """Create the session state table without blocking the event loop."""

        if self._schema_ready:
            return

        async with self._schema_lock:
            if self._schema_ready:
                return
            await asyncio.to_thread(self._ensure_schema_sync)
            self._schema_ready = True

    async def get_previous_response_id(self, session_id: str) -> str | None:
        """Return the latest response ID for a session, if known."""

        await self._ensure_schema()
        return await asyncio.to_thread(self._get_previous_response_id_sync, session_id)

    def _get_previous_response_id_sync(self, session_id: str) -> str | None:
        """Return the latest response ID using the cached SQLite connection."""

        with self._connection_lock:
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

    async def set_previous_response_id(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID for a session."""

        await self._ensure_schema()
        await asyncio.to_thread(
            self._set_previous_response_id_sync,
            session_id,
            response_id,
        )

    def _set_previous_response_id_sync(
        self,
        session_id: str,
        response_id: str,
    ) -> None:
        """Persist the latest response ID using the cached SQLite connection."""

        with self._connection_lock:
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

    async def clear(self, session_id: str) -> None:
        """Forget state for one session."""

        await self._ensure_schema()
        await asyncio.to_thread(self._clear_sync, session_id)

    def _clear_sync(self, session_id: str) -> None:
        """Forget state for one session using the cached SQLite connection."""

        with self._connection_lock:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM session_state WHERE session_id = ?",
                    (session_id,),
                )
                connection.execute(
                    "DELETE FROM session_transcript WHERE session_id = ?",
                    (session_id,),
                )

    async def append_transcript_event(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append one minimal transcript event without blocking the event loop."""

        await self._ensure_schema()
        await asyncio.to_thread(
            self._append_transcript_event_sync,
            session_id,
            role,
            content,
        )

    def _append_transcript_event_sync(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        """Append one transcript event using the cached SQLite connection."""

        with self._connection_lock:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO session_transcript (session_id, role, content)
                    VALUES (?, ?, ?)
                    """,
                    (session_id, role, content),
                )

    async def get_transcript(self, session_id: str) -> list[dict[str, str]]:
        """Return transcript events without blocking the event loop."""

        await self._ensure_schema()
        return await asyncio.to_thread(self._get_transcript_sync, session_id)

    def _get_transcript_sync(self, session_id: str) -> list[dict[str, str]]:
        """Load transcript events using the cached SQLite connection."""

        with self._connection_lock:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT role, content
                    FROM session_transcript
                    WHERE session_id = ?
                    ORDER BY id ASC
                    """,
                    (session_id,),
                ).fetchall()

        return [
            {"role": str(role), "content": str(content)}
            for role, content in rows
        ]
