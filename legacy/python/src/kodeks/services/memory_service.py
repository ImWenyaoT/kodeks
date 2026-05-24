import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from kodeks.core.config import MEMORY_LOG_PATH


def _memory_terms(text: str) -> set[str]:
    """Extract normalized terms for lightweight memory recall."""

    return {
        term
        for term in re.findall(r"[A-Za-z0-9_\u4e00-\u9fff]+", text.lower())
        if len(term) > 1
    }


class InMemoryMemoryStore:
    """In-process memory store for runtime tests and lightweight injection."""

    def __init__(self) -> None:
        self._records: list[dict[str, Any]] = []

    def remember(
        self,
        content: str,
        *,
        scope: str = "project",
        source_session_id: str | None = None,
    ) -> str:
        """Store one auditable memory record and return its id."""

        content = content.strip()
        if not content:
            raise ValueError("Memory content is empty")

        memory_id = f"mem_{uuid4().hex}"
        self._records.append(
            {
                "memory_id": memory_id,
                "timestamp": datetime.now(UTC).isoformat(),
                "scope": scope,
                "source_session_id": source_session_id,
                "content": content,
            }
        )
        return memory_id

    def recall(self, query: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """Return memory records ranked by simple term overlap."""

        query_terms = _memory_terms(query)
        if not query_terms:
            return []

        ranked_records: list[tuple[int, dict[str, Any]]] = []
        for record in self._records:
            score = len(query_terms & _memory_terms(str(record.get("content", ""))))
            if score > 0:
                ranked_records.append((score, record))

        ranked_records.sort(key=lambda item: item[0], reverse=True)
        return [record for _, record in ranked_records[:limit]]


class JSONLMemoryStore(InMemoryMemoryStore):
    """Append-only JSONL memory store for project/user/session facts."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or MEMORY_LOG_PATH
        super().__init__()

    def remember(
        self,
        content: str,
        *,
        scope: str = "project",
        source_session_id: str | None = None,
    ) -> str:
        """Append one memory record to disk and return its id."""

        memory_id = super().remember(
            content,
            scope=scope,
            source_session_id=source_session_id,
        )
        record = self._records[-1]
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
            file.write("\n")
        return memory_id

    def recall(self, query: str, *, limit: int = 5) -> list[dict[str, Any]]:
        """Read memory records from disk and return relevant matches."""

        self._records = self._load_records()
        return super().recall(query, limit=limit)

    def _load_records(self) -> list[dict[str, Any]]:
        """Load valid JSONL memory records, ignoring corrupted lines."""

        if not self._path.exists():
            return []

        records: list[dict[str, Any]] = []
        with self._path.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
        return records
