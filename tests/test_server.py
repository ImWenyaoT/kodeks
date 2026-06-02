from kodeks.server import main


def test_server_cli_starts_uvicorn_with_python_app(monkeypatch):
    """Server CLI starts the migrated Python ASGI app."""

    calls: list[dict[str, object]] = []

    def fake_run(app: str, **kwargs: object) -> None:
        """Capture uvicorn startup options without opening a socket."""

        calls.append({"app": app, **kwargs})

    monkeypatch.setattr("kodeks.server.uvicorn.run", fake_run)

    exit_code = main(
        [
            "--host",
            "0.0.0.0",
            "--port",
            "8123",
            "--reload",
            "--log-level",
            "debug",
        ]
    )

    assert exit_code == 0
    assert calls == [
        {
            "app": "kodeks.app:app",
            "host": "0.0.0.0",
            "port": 8123,
            "reload": True,
            "log_level": "debug",
        }
    ]


def test_server_cli_defaults_to_local_python_runtime(monkeypatch):
    """Server CLI defaults match the documented local runtime."""

    calls: list[dict[str, object]] = []

    def fake_run(app: str, **kwargs: object) -> None:
        """Capture default uvicorn startup options."""

        calls.append({"app": app, **kwargs})

    monkeypatch.setattr("kodeks.server.uvicorn.run", fake_run)

    assert main([]) == 0
    assert calls == [
        {
            "app": "kodeks.app:app",
            "host": "127.0.0.1",
            "port": 8000,
            "reload": False,
            "log_level": "info",
        }
    ]
