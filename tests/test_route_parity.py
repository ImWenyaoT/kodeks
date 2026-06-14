import json

from fastapi.testclient import TestClient

from kodeks.app import create_app
from kodeks.storage import KodeksDatabase, current_timestamp
from kodeks.workspace import command_hash


def test_sessions_list_includes_active_plan_and_get_transcript(tmp_path, monkeypatch):
    """Session routes expose activePlan and transcript shapes used by Next."""

    db_path = tmp_path / "kodeks.sqlite3"
    monkeypatch.setenv("KODEKS_DB_PATH", str(db_path))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    database = KodeksDatabase(str(db_path))
    try:
        session = database.sessions.create_session(
            title="Parity",
            mode="act",
            workspace_root=str(tmp_path),
            session_id="sess_parity",
        )
        database.sessions.append_message(session.id, "user", {"text": "hello"})
        now = current_timestamp()
        database.connection.execute(
            """
            INSERT INTO plan_artifacts
              (id, session_id, title, summary, steps_json, status, source_message_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "plan_active",
                session.id,
                "Plan",
                "Do the work",
                json.dumps(
                    [
                        {
                            "id": "step_1",
                            "title": "Inspect",
                            "status": "completed",
                            "details": None,
                        }
                    ]
                ),
                "active",
                "msg_source",
                now,
                now,
            ),
        )
        database.connection.commit()
    finally:
        database.close()

    client = TestClient(create_app())

    listed = client.get("/api/sessions")
    loaded = client.get("/api/sessions/sess_parity")
    missing = client.get("/api/sessions/missing")

    assert listed.status_code == 200
    assert listed.json()["sessions"][0]["activePlan"]["id"] == "plan_active"
    assert listed.json()["sessions"][0]["activePlan"]["steps"][0]["id"] == "step_1"
    assert loaded.status_code == 200
    assert loaded.json()["session"]["id"] == "sess_parity"
    assert loaded.json()["messages"][0]["content"] == {"text": "hello"}
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Session not found."}


def test_workspace_files_route_lists_visible_files_only(tmp_path, monkeypatch):
    """Workspace file route keeps the same visible-file boundary as the UI."""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('ok')\n")
    (tmp_path / ".kodeks").mkdir()
    (tmp_path / ".kodeks" / "secret.json").write_text("{}\n")
    (tmp_path / ".ruff_cache").mkdir()
    (tmp_path / ".ruff_cache" / "CACHEDIR.TAG").write_text("cache\n")
    (tmp_path / ".uv-cache").mkdir()
    (tmp_path / ".uv-cache" / "CACHEDIR.TAG").write_text("cache\n")
    (tmp_path / ".env.backup").write_text("OPENAI_API_KEY=secret\n")
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    client = TestClient(create_app())

    response = client.get("/api/workspace/files")

    assert response.status_code == 200
    assert response.json() == {"files": ["src/app.py"]}


def test_favicon_route_keeps_browser_console_clean(tmp_path, monkeypatch):
    """Favicon requests get a non-error response from the Python web app."""

    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    client = TestClient(create_app())

    response = client.get("/favicon.ico")

    assert response.status_code == 204
    assert response.content == b""


def test_approval_routes_execute_once_and_record_audit(tmp_path, monkeypatch):
    """Approval routes preserve reject/approve status codes and audit records."""

    db_path = tmp_path / "kodeks.sqlite3"
    monkeypatch.setenv("KODEKS_DB_PATH", str(db_path))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    database = KodeksDatabase(str(db_path))
    try:
        rejected = database.approvals.create_approval(
            command={"command": "echo no"},
            reason="needs approval",
            session_id="sess_approval",
            tool_call_id="call_reject",
        )
        approved = database.approvals.create_approval(
            command={"command": "printf ok"},
            reason="needs approval",
            session_id="sess_approval",
            tool_call_id="call_run",
        )
        malformed = database.approvals.create_approval(
            command={"notCommand": "echo nope"},
            reason="needs approval",
            session_id="sess_approval",
        )
    finally:
        database.close()

    client = TestClient(create_app())

    assert client.get(f"/api/approvals/{rejected.id}").json()["approval"][
        "status"
    ] == "pending"
    rejected_response = client.post(
        f"/api/approvals/{rejected.id}",
        json={"decision": "reject", "reason": "not today"},
    )
    approved_response = client.post(
        f"/api/approvals/{approved.id}",
        json={"decision": "approve", "expectedCommandHash": command_hash("printf ok")},
    )
    repeated_response = client.post(
        f"/api/approvals/{approved.id}",
        json={"decision": "approve", "expectedCommandHash": command_hash("printf ok")},
    )
    malformed_response = client.post(
        f"/api/approvals/{malformed.id}", json={"decision": "approve"}
    )
    invalid_response = client.post(
        f"/api/approvals/{rejected.id}", json={"decision": "maybe"}
    )
    missing_response = client.get("/api/approvals/appr_missing")

    assert rejected_response.status_code == 200
    assert rejected_response.json()["approval"]["status"] == "rejected"
    assert rejected_response.json()["approval"]["reason"] == "not today"
    assert approved_response.status_code == 200
    assert approved_response.json()["approval"]["status"] == "executed"
    assert approved_response.json()["result"]["stdout"] == "ok"
    assert repeated_response.status_code == 409
    assert malformed_response.status_code == 400
    assert invalid_response.status_code == 400
    assert missing_response.status_code == 404

    audit_db = KodeksDatabase(str(db_path))
    try:
        rows = audit_db.connection.execute(
            "SELECT event_type, payload_json FROM audit_log ORDER BY rowid ASC"
        ).fetchall()
    finally:
        audit_db.close()
    assert [row["event_type"] for row in rows] == [
        "approval_rejected",
        "approval_executed",
    ]
    assert json.loads(rows[1]["payload_json"])["stdout"] == "ok"


def test_approval_routes_do_not_shell_parse_approved_commands(tmp_path, monkeypatch):
    """Approval execution refuses shell-only syntax instead of misrunning argv."""

    db_path = tmp_path / "kodeks.sqlite3"
    monkeypatch.setenv("KODEKS_DB_PATH", str(db_path))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    database = KodeksDatabase(str(db_path))
    try:
        approval = database.approvals.create_approval(
            command={"command": "pytest -q 2>&1"},
            reason="needs approval",
            session_id="sess_approval",
            tool_call_id="call_shell_syntax",
        )
    finally:
        database.close()

    response = TestClient(create_app()).post(
        f"/api/approvals/{approval.id}",
        json={
            "decision": "approve",
            "expectedCommandHash": command_hash("pytest -q 2>&1"),
        },
    )

    assert response.status_code == 200
    assert response.json()["approval"]["status"] == "executed"
    assert response.json()["result"]["exitCode"] is None
    assert "without a shell" in response.json()["result"]["stderr"]


def test_bridge_preflight_preserves_provider_labels_and_missing_states(
    tmp_path, monkeypatch
):
    """Bridge preflight reports MoonBridge missing states."""

    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("KODEKS_CHAT_COMPLETIONS_API_KEY", raising=False)
    monkeypatch.delenv("KODEKS_CHAT_COMPLETIONS_BASE_URL", raising=False)
    monkeypatch.delenv("KODEKS_CHAT_COMPLETIONS_MODEL", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    monkeypatch.delenv("BASE_URL", raising=False)
    monkeypatch.delenv("MODEL", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_BASE_URL", raising=False)
    monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    client = TestClient(create_app())

    missing = client.post("/api/bridge/preflight", json={"provider": "openai"})

    assert missing.status_code == 200
    assert missing.json()["status"] == "unavailable"
    assert missing.json()["provider"] == "auto"
    assert missing.json()["code"] == "model_configuration_error"
    assert "outside the Kodeks product boundary" in missing.json()["reason"]


def test_bridge_preflight_reports_unreachable_chat_completions_upstream(
    tmp_path, monkeypatch
):
    """Bridge preflight reports live upstream failures instead of false ready."""

    async def fake_unreachable(_base_url, _api_key):
        """Return a deterministic failed upstream probe for route assertions."""

        return {
            "code": "moonbridge_upstream_unreachable",
            "reason": "Configured Chat Completions upstream is unreachable: test.",
        }

    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("KODEKS_MODEL_PROVIDER", "moonbridge")
    monkeypatch.setenv("KODEKS_CHAT_COMPLETIONS_API_KEY", "local-placeholder")
    monkeypatch.setenv("KODEKS_CHAT_COMPLETIONS_BASE_URL", "http://local.test/v1")
    monkeypatch.setenv("KODEKS_CHAT_COMPLETIONS_MODEL", "deepseek-v4-pro")
    monkeypatch.setattr(
        "kodeks.app._check_chat_completions_upstream", fake_unreachable
    )
    client = TestClient(create_app())

    response = client.post(
        "/api/bridge/preflight", json={"model": "deepseek/deepseek-v4-pro"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "unavailable"
    assert body["code"] == "moonbridge_upstream_unreachable"
    assert body["upstreamBaseURL"] == "http://local.test/v1"
