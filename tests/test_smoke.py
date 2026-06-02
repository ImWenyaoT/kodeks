import json

import httpx

from kodeks.smoke import main, run_in_process_smoke_checks, run_smoke_checks


def test_in_process_smoke_checks_validate_fastapi_app(tmp_path, monkeypatch):
    """In-process smoke validates the FastAPI app without local sockets."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))

    results = run_in_process_smoke_checks()

    assert [result.name for result in results] == [
        "health",
        "models",
        "chat_stream",
        "bridge_preflight",
    ]
    assert all(result.ok for result in results)


def test_smoke_checks_cover_runtime_routes_without_live_provider():
    """Smoke checks validate stable runtime HTTP contracts with a mock transport."""

    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        """Return the expected Kodeks smoke response for one request."""

        seen_paths.append(request.url.path)
        if request.url.path == "/health":
            return httpx.Response(200, json={"ok": True, "runtime": "python"})
        if request.url.path == "/api/models":
            return httpx.Response(200, json={"models": []})
        if request.url.path == "/api/chat/stream":
            payload = json.loads(request.content)
            assert payload == {"session_id": "smoke_missing_input"}
            return httpx.Response(
                200,
                text='event: error\ndata: {"message":"Input is required."}\n\n',
            )
        if request.url.path == "/api/bridge/preflight":
            return httpx.Response(200, json={"status": "ready"})
        return httpx.Response(404, json={"error": "not_found"})

    client = httpx.Client(
        base_url="http://runtime.test", transport=httpx.MockTransport(handler)
    )

    results = run_smoke_checks("http://runtime.test", client=client)

    assert [result.name for result in results] == [
        "health",
        "models",
        "chat_stream",
        "bridge_preflight",
    ]
    assert all(result.ok for result in results)
    assert seen_paths == [
        "/health",
        "/api/models",
        "/api/chat/stream",
        "/api/bridge/preflight",
    ]


def test_smoke_checks_can_include_live_provider_route():
    """Live-provider smoke also checks the Responses-shaped bridge route."""

    def handler(request: httpx.Request) -> httpx.Response:
        """Return successful responses for all smoke endpoints."""

        if request.url.path == "/health":
            return httpx.Response(200, json={"ok": True, "runtime": "python"})
        if request.url.path == "/api/models":
            return httpx.Response(200, json={"models": []})
        if request.url.path == "/api/chat/stream":
            return httpx.Response(
                200,
                text='event: error\ndata: {"message":"Input is required."}\n\n',
            )
        if request.url.path == "/api/bridge/preflight":
            payload = json.loads(request.content)
            assert payload == {"model": "qwen/qwen3.6"}
            return httpx.Response(200, json={"status": "ready"})
        if request.url.path == "/v1/responses":
            payload = json.loads(request.content)
            assert payload == {
                "model": "qwen/qwen3.6",
                "input": "hello",
                "stream": False,
            }
            return httpx.Response(200, json={"id": "resp_smoke"})
        return httpx.Response(404, json={"error": "not_found"})

    client = httpx.Client(
        base_url="http://runtime.test", transport=httpx.MockTransport(handler)
    )

    results = run_smoke_checks(
        "http://runtime.test",
        client=client,
        include_live_provider=True,
        model="qwen/qwen3.6",
    )

    assert [result.name for result in results] == [
        "health",
        "models",
        "chat_stream",
        "bridge_preflight",
        "live_responses",
    ]
    assert all(result.ok for result in results)


def test_smoke_cli_returns_failure_when_any_check_fails(monkeypatch):
    """CLI exit code reflects failed smoke checks."""

    def fake_smoke_checks(
        base_url: str,
        *,
        include_live_provider: bool = False,
        model: str = "moonbridge",
    ) -> list[object]:
        """Return one failed result while preserving CLI argument plumbing."""

        assert base_url == "http://runtime.test"
        assert include_live_provider is True
        assert model == "moonbridge"
        return [type("Result", (), {"ok": False, "name": "health", "message": "bad"})()]

    monkeypatch.setattr("kodeks.smoke.run_smoke_checks", fake_smoke_checks)

    assert main(["--base-url", "http://runtime.test", "--live-provider"]) == 1


def test_smoke_cli_can_run_in_process(monkeypatch):
    """CLI can smoke-check the FastAPI app without opening a socket."""

    def fake_in_process_smoke_checks(
        *,
        include_live_provider: bool = False,
        model: str = "moonbridge",
    ) -> list[object]:
        """Return one successful result while preserving CLI argument plumbing."""

        assert include_live_provider is False
        assert model == "qwen/qwen3.6"
        return [type("Result", (), {"ok": True, "name": "health", "message": "ok"})()]

    monkeypatch.setattr(
        "kodeks.smoke.run_in_process_smoke_checks", fake_in_process_smoke_checks
    )

    assert main(["--in-process", "--model", "qwen/qwen3.6"]) == 0


def test_smoke_checks_report_connection_errors_without_tracebacks():
    """Smoke checks convert network failures into failed result rows."""

    def handler(_request: httpx.Request) -> httpx.Response:
        """Raise the same class of error as a blocked local socket."""

        raise httpx.ConnectError("operation not permitted")

    client = httpx.Client(
        base_url="http://runtime.test", transport=httpx.MockTransport(handler)
    )

    results = run_smoke_checks("http://runtime.test", client=client)

    assert [result.ok for result in results] == [False, False, False, False]
    assert all("operation not permitted" in result.message for result in results)


def test_in_process_live_smoke_reports_provider_connection_errors(monkeypatch):
    """In-process live-provider smoke reports upstream connection failures."""

    def fail_live_provider(_client: object, _model: str) -> object:
        """Raise the error produced when an upstream provider is unreachable."""

        raise httpx.ConnectError("all connection attempts failed")

    monkeypatch.setattr(
        "kodeks.smoke._check_testclient_live_responses", fail_live_provider
    )

    results = run_in_process_smoke_checks(
        include_live_provider=True, model="qwen/qwen3.6"
    )

    assert [result.name for result in results] == [
        "health",
        "models",
        "chat_stream",
        "bridge_preflight",
        "live_responses",
    ]
    assert results[-1].ok is False
    assert "all connection attempts failed" in results[-1].message
