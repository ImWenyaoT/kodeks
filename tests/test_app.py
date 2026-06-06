from fastapi.testclient import TestClient

from kodeks.app import create_app


def test_health_route():
    """FastAPI service exposes a health route for runtime smoke checks."""

    client = TestClient(create_app())

    assert client.get("/health").json() == {"ok": True, "runtime": "python"}


def test_python_runtime_serves_static_ui():
    """FastAPI serves the built Next static export as the browser UI."""

    client = TestClient(create_app())

    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    # The built Next export references its asset bundles under /_next/.
    assert "/_next/" in response.text


def test_cors_preflight_does_not_allow_old_next_shell_by_default():
    """External browser origins must opt in explicitly."""

    client = TestClient(create_app())

    response = client.options(
        "/api/models",
        headers={
            "Origin": "http://127.0.0.1:3000",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_cors_preflight_allows_explicit_external_browser_shell(monkeypatch):
    """External browser shells must opt in through KODEKS_CORS_ORIGINS."""

    monkeypatch.setenv("KODEKS_CORS_ORIGINS", "http://127.0.0.1:5173")
    client = TestClient(create_app())

    response = client.options(
        "/api/models",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_sessions_route_uses_shared_sqlite_schema(tmp_path, monkeypatch):
    """Session routes can create and read records through the Python repository."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    client = TestClient(create_app())

    created = client.post(
        "/api/sessions",
        json={"session_id": "sess_py", "title": "Python", "mode": "plan"},
    )

    assert created.status_code == 201
    assert created.json()["session"]["id"] == "sess_py"
    assert client.get("/api/sessions/sess_py").json()["session"]["mode"] == "plan"


def test_python_chat_stream_reports_missing_input(tmp_path, monkeypatch):
    """Chat route now enters the Python loop and validates input."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    client = TestClient(create_app())

    response = client.post("/api/chat/stream", json={"session_id": "sess_py"})

    assert response.status_code == 200
    assert "Input is required." in response.text


def test_python_ui_chat_stream_reports_missing_input(tmp_path, monkeypatch):
    """UI transport route maps Python loop errors into UI payloads."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    client = TestClient(create_app())

    response = client.post("/api/chat/ui", json={"session_id": "sess_py"})

    assert response.status_code == 200
    assert "Input is required." in response.text
    assert "errorText" in response.text
