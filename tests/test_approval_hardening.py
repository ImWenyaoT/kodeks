"""Regression tests for the f5376fe hardenings ported onto the Python backend.

Covers: approval command-hash binding (producer + verifier), the failed terminal
approval state, and the plan-mode execution-layer tool allow-list.
"""

import json

import pytest
from fastapi.testclient import TestClient

from kodeks.api.ui_transport import to_ui_transport_payload
from kodeks.app import create_app
from kodeks.runtime import run_python_chat_turn
from kodeks.storage import (
    ApprovalAlreadyResolvedError,
    ApprovalNotFoundError,
    KodeksDatabase,
)
from kodeks.workspace import command_hash


def _make_pending_approval(db_path, command, monkeypatch, tmp_path):
    """Create one pending approval in a fresh DB and point the app env at it."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(db_path))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    database = KodeksDatabase(str(db_path))
    try:
        approval = database.approvals.create_approval(
            command={"command": command},
            reason="needs approval",
            session_id="sess_hardening",
            tool_call_id="call_x",
        )
    finally:
        database.close()
    return approval


def _approval_status(db_path, approval_id):
    """Read one approval's status through a fresh connection."""

    database = KodeksDatabase(str(db_path))
    try:
        return database.approvals.get_approval(approval_id).status
    finally:
        database.close()


def test_approve_requires_command_hash(tmp_path, monkeypatch):
    """Approve without expectedCommandHash is rejected (409) and does not execute."""

    db_path = tmp_path / "kodeks.sqlite3"
    approval = _make_pending_approval(db_path, "printf ok", monkeypatch, tmp_path)

    response = TestClient(create_app()).post(
        f"/api/approvals/{approval.id}", json={"decision": "approve"}
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Approval command hash is required."
    assert _approval_status(db_path, approval.id) == "pending"


def test_approve_rejects_command_hash_mismatch(tmp_path, monkeypatch):
    """A hash that does not match the stored command is rejected (409)."""

    db_path = tmp_path / "kodeks.sqlite3"
    approval = _make_pending_approval(db_path, "printf ok", monkeypatch, tmp_path)

    response = TestClient(create_app()).post(
        f"/api/approvals/{approval.id}",
        json={
            "decision": "approve",
            "expectedCommandHash": command_hash("printf EVIL"),
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "Approval command hash mismatch."
    assert _approval_status(db_path, approval.id) == "pending"


def test_approve_accepts_matching_command_hash(tmp_path, monkeypatch):
    """Byte-identity guard: sha256(stored command) matches and executes once."""

    db_path = tmp_path / "kodeks.sqlite3"
    approval = _make_pending_approval(db_path, "printf ok", monkeypatch, tmp_path)

    response = TestClient(create_app()).post(
        f"/api/approvals/{approval.id}",
        json={"decision": "approve", "expectedCommandHash": command_hash("printf ok")},
    )

    assert response.status_code == 200
    assert response.json()["approval"]["status"] == "executed"
    assert response.json()["result"]["stdout"] == "ok"


def test_mark_failed_transitions(tmp_path):
    """mark_failed moves approved->failed; missing/non-approved raise stable errors."""

    database = KodeksDatabase(":memory:")
    try:
        approval = database.approvals.create_approval(
            command={"command": "printf ok"},
            reason="needs approval",
            session_id="sess_failed",
            tool_call_id="call_f",
        )
        with pytest.raises(ApprovalNotFoundError):
            database.approvals.mark_failed("appr_missing", "boom")
        with pytest.raises(ApprovalAlreadyResolvedError):
            database.approvals.mark_failed(approval.id, "boom")  # still pending
        database.approvals.approve(approval.id)
        failed = database.approvals.mark_failed(approval.id, "boom")
        assert failed.status == "failed"
        assert failed.reason == "boom"
    finally:
        database.close()


def test_approve_records_failed_on_execution_error(tmp_path, monkeypatch):
    """A failing approved execution lands the record in the terminal failed state."""

    db_path = tmp_path / "kodeks.sqlite3"
    approval = _make_pending_approval(db_path, "printf ok", monkeypatch, tmp_path)

    def _boom(command, workspace_root):
        raise RuntimeError("executor down")

    monkeypatch.setattr("kodeks.api.approval_routes.run_approved_command", _boom)
    response = TestClient(create_app(), raise_server_exceptions=False).post(
        f"/api/approvals/{approval.id}",
        json={"decision": "approve", "expectedCommandHash": command_hash("printf ok")},
    )

    assert response.status_code == 500
    assert _approval_status(db_path, approval.id) == "failed"


def _shell_approval_events(body, env):
    """Inject a dangerous run_shell call that requires approval."""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_shell",
                "name": "run_shell",
                "arguments": json.dumps({"command": "rm -rf build"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_a", "status": "completed"},
        },
    ]


def _write_file_events(body, env):
    """Inject a write_file call (a mutating tool) for plan-mode gating."""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_write",
                "name": "write_file",
                "arguments": json.dumps({"path": "notes.txt", "content": "x"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_w", "status": "completed"},
        },
    ]


async def test_approval_required_event_carries_command_and_hash(tmp_path):
    """Producer binds the approval command + its sha256 onto event and UI payload."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "clean", "session_id": "sess_hash", "mode": "act"},
                database,
                str(tmp_path),
                {},
                _shell_approval_events,
            )
        ]
    finally:
        database.close()

    approval_event = next(e for e in events if e["type"] == "approval_required")
    assert approval_event["command"] == "rm -rf build"
    assert approval_event["command_hash"] == command_hash("rm -rf build")
    ui = to_ui_transport_payload(approval_event)
    assert ui is not None
    assert ui["command"] == "rm -rf build"
    assert ui["commandHash"] == command_hash("rm -rf build")


async def test_plan_mode_blocks_write_tool(tmp_path):
    """Plan mode hard-blocks a mutating tool at the execution layer."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "edit", "session_id": "sess_plan_gate", "mode": "plan"},
                database,
                str(tmp_path),
                {},
                _write_file_events,
            )
        ]
    finally:
        database.close()

    tool_result = next(e for e in events if e["type"] == "tool_result")
    assert tool_result["tool_status"] == "error"
    assert (
        tool_result["tool_output"]
        == "Tool not allowed in the current mode: write_file"
    )
    error = next(e for e in events if e["type"] == "error")
    assert error["code"] == "tool_not_allowed_in_mode"
