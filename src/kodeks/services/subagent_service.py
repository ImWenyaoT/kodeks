import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from kodeks.core.config import SUBAGENT_LOG_PATH


def run_subagent(
    *,
    task: str,
    context: str = "",
    session_id: str | None = None,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Run a minimal local subagent task and append an auditable summary."""

    task = task.strip()
    context = context.strip()
    if not task:
        raise ValueError("Subagent task is empty")

    subagent_id = f"sub_{uuid4().hex}"
    summary = f"Subagent completed task: {task}"
    if context:
        summary = f"{summary}. Context: {context}"

    record: dict[str, Any] = {
        "subagent_id": subagent_id,
        "timestamp": datetime.now(UTC).isoformat(),
        "session_id": session_id,
        "task": task,
        "context": context,
        "status": "completed",
        "summary": summary,
    }
    path = log_path or SUBAGENT_LOG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
        file.write("\n")

    return record
