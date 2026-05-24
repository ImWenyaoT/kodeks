# q1: 为什么 Phase 5B 要先做 audit log，而不是等完整 approval UI？
# a1: mutating tool 和 shell tool 一旦进入 agent loop，就必须留下可追踪记录。即使 Phase 6 才做批准/拒绝接口，Phase 5B 也要证明危险命令不会静默执行。
# q2: 为什么 audit log 只保存 arguments summary？
# a2: 工具参数可能包含文件内容或敏感信息。第一版只记录排障和审批需要的最小信息，避免把完整 payload 复制进永久状态。

import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from kodeks.core.config import TOOL_AUDIT_LOG_PATH
from kodeks.services import shell_service


class ApprovalNotFoundError(Exception):
    """Raised when an approval id has no audit records."""


class ApprovalAlreadyResolvedError(Exception):
    """Raised when an approval id is no longer pending."""


class ApprovalExecutionTimeoutError(Exception):
    """Raised when an approved command times out."""


@dataclass(frozen=True)
class _ApprovalBoundsCacheEntry:
    """Cached first/latest audit records for one unchanged approval log."""

    size: int
    mtime_ns: int
    first_record: dict[str, Any] | None
    latest_record: dict[str, Any] | None


_approval_bounds_cache: dict[tuple[Path, str], _ApprovalBoundsCacheEntry] = {}


def record_approval_required(
    *,
    session_id: str | None,
    tool_call_id: str | None,
    tool_name: str,
    reason: str,
    arguments_summary: dict[str, Any],
    log_path: Path | None = None,
) -> str:
    """Append one pending approval record and return its approval id."""

    approval_id = f"appr_{uuid4().hex}"
    path = log_path or TOOL_AUDIT_LOG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    record = {
        "approval_id": approval_id,
        "timestamp": datetime.now(UTC).isoformat(),
        "session_id": session_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "decision": "ask",
        "status": "pending",
        "reason": reason,
        "arguments_summary": arguments_summary,
    }

    _append_record(path, record)

    return approval_id


def get_approval_status(
    approval_id: str,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Return the latest known status for one approval id."""

    first_record, latest_record = _record_bounds_for_approval(approval_id, log_path)
    if first_record is None or latest_record is None:
        raise ApprovalNotFoundError(approval_id)

    return {
        "approval_id": approval_id,
        "status": latest_record["status"],
        "decision": latest_record["decision"],
        "tool_name": first_record.get("tool_name"),
        "session_id": first_record.get("session_id"),
        "tool_call_id": first_record.get("tool_call_id"),
        "arguments_summary": first_record.get("arguments_summary", {}),
        "latest": latest_record,
    }


def approve_approval(
    approval_id: str,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Approve a pending shell command and execute it once."""

    pending_record = _require_pending_record(approval_id, log_path)
    command = _command_from_record(pending_record)
    path = log_path or TOOL_AUDIT_LOG_PATH

    _append_record(
        path,
        _child_record(
            pending_record,
            decision="approve",
            status="approved",
            reason="Approved by user",
        ),
    )

    try:
        result = shell_service.run_approved_command(command)
    except shell_service.ShellCommandTimeoutError as exc:
        timeout_record = _child_record(
            pending_record,
            decision="execute",
            status="execution_timeout",
            reason="Approved command timed out",
        )
        _append_record(path, timeout_record)
        raise ApprovalExecutionTimeoutError(approval_id) from exc

    execution_record = _child_record(
        pending_record,
        decision="execute",
        status="executed",
        reason="Approved command executed",
        result={
            "command": result.command,
            "exit_code": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
        },
    )
    _append_record(path, execution_record)

    return execution_record


def reject_approval(
    approval_id: str,
    reason: str | None = None,
    log_path: Path | None = None,
) -> dict[str, Any]:
    """Reject a pending approval without executing its command."""

    pending_record = _require_pending_record(approval_id, log_path)
    path = log_path or TOOL_AUDIT_LOG_PATH
    rejection_record = _child_record(
        pending_record,
        decision="reject",
        status="rejected",
        reason=reason or "Rejected by user",
    )
    _append_record(path, rejection_record)
    return rejection_record


def _records_for_approval(
    approval_id: str,
    log_path: Path | None = None,
) -> list[dict[str, Any]]:
    """Load all JSONL records for one approval id."""

    return list(_iter_records_for_approval(approval_id, log_path))


def _record_bounds_for_approval(
    approval_id: str,
    log_path: Path | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Return the first and latest records for one approval without storing all matches."""

    path = log_path or TOOL_AUDIT_LOG_PATH
    log_signature = _log_signature(path)
    cache_key = (path.resolve(), approval_id)
    cached_entry = _approval_bounds_cache.get(cache_key)
    if (
        log_signature is not None
        and cached_entry is not None
        and cached_entry.size == log_signature[0]
        and cached_entry.mtime_ns == log_signature[1]
    ):
        return cached_entry.first_record, cached_entry.latest_record

    first_record, latest_record = _find_approval_record_bounds(
        approval_id,
        _iter_records_for_approval(approval_id, path),
    )
    if log_signature is not None:
        _approval_bounds_cache[cache_key] = _ApprovalBoundsCacheEntry(
            size=log_signature[0],
            mtime_ns=log_signature[1],
            first_record=first_record,
            latest_record=latest_record,
        )

    return first_record, latest_record


def _find_approval_record_bounds(
    approval_id: str,
    records: Iterable[dict[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Return first and latest matching approval records from an iterable."""

    first_record: dict[str, Any] | None = None
    latest_record: dict[str, Any] | None = None

    for record in records:
        if record.get("approval_id") != approval_id:
            continue
        if first_record is None:
            first_record = record
        latest_record = record

    return first_record, latest_record


def _iter_records_for_approval(
    approval_id: str,
    log_path: Path | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield valid JSONL records for one approval id."""

    path = log_path or TOOL_AUDIT_LOG_PATH
    if not path.exists():
        return

    with path.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("approval_id") == approval_id:
                yield record


def _require_pending_record(
    approval_id: str,
    log_path: Path | None,
) -> dict[str, Any]:
    """Return the original pending record or raise a domain error."""

    first_record, latest_record = _record_bounds_for_approval(approval_id, log_path)
    if first_record is None or latest_record is None:
        raise ApprovalNotFoundError(approval_id)

    if latest_record.get("status") != "pending":
        raise ApprovalAlreadyResolvedError(approval_id)

    return first_record


def _command_from_record(record: dict[str, Any]) -> str:
    """Extract the approved shell command from an approval record."""

    arguments_summary = record.get("arguments_summary", {})
    command = arguments_summary.get("command") if isinstance(arguments_summary, dict) else None
    if not isinstance(command, str) or not command.strip():
        raise ValueError("Approval record does not contain a shell command")

    return command


def _child_record(
    parent: dict[str, Any],
    *,
    decision: str,
    status: str,
    reason: str,
    result: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a follow-up audit record for an existing approval id."""

    record: dict[str, Any] = {
        "approval_id": parent["approval_id"],
        "timestamp": datetime.now(UTC).isoformat(),
        "session_id": parent.get("session_id"),
        "tool_call_id": parent.get("tool_call_id"),
        "tool_name": parent.get("tool_name"),
        "decision": decision,
        "status": status,
        "reason": reason,
        "arguments_summary": parent.get("arguments_summary", {}),
    }
    if result is not None:
        record["result"] = result

    return record


def _append_record(path: Path, record: dict[str, Any]) -> None:
    """Append one audit record to disk."""

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
        file.write("\n")

    approval_id = record.get("approval_id")
    if isinstance(approval_id, str):
        _refresh_appended_record_cache(path, approval_id, record)


def _log_signature(path: Path) -> tuple[int, int] | None:
    """Return the audit log size and mtime used to validate cached lookups."""

    if not path.exists():
        return None

    stat_result = path.stat()
    return stat_result.st_size, stat_result.st_mtime_ns


def _refresh_appended_record_cache(
    path: Path,
    approval_id: str,
    record: dict[str, Any],
) -> None:
    """Update a cached approval lookup after this process appends a new record."""

    log_signature = _log_signature(path)
    if log_signature is None:
        return

    cache_key = (path.resolve(), approval_id)
    cached_entry = _approval_bounds_cache.get(cache_key)
    first_record = cached_entry.first_record if cached_entry is not None else record
    _approval_bounds_cache[cache_key] = _ApprovalBoundsCacheEntry(
        size=log_signature[0],
        mtime_ns=log_signature[1],
        first_record=first_record,
        latest_record=record,
    )
