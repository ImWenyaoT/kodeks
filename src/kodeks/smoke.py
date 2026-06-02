"""HTTP smoke checks for deployed or locally running Kodeks runtimes."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from fastapi.testclient import TestClient

from .app import create_app


@dataclass(frozen=True)
class SmokeResult:
    """One smoke-check result with enough detail for CI logs."""

    name: str
    ok: bool
    message: str


class SmokeResponse(Protocol):
    """Minimal response interface shared by httpx and httpx2 responses."""

    @property
    def status_code(self) -> int:
        """Return the HTTP status code."""

    @property
    def content(self) -> bytes:
        """Return the raw response body bytes."""

    @property
    def text(self) -> str:
        """Return the decoded response body text."""

    def json(self) -> Any:
        """Decode the response body as JSON."""


def run_smoke_checks(
    base_url: str,
    *,
    client: httpx.Client | None = None,
    include_live_provider: bool = False,
    model: str = "moonbridge",
) -> list[SmokeResult]:
    """Run Kodeks HTTP smoke checks against one runtime base URL."""

    close_client = client is None
    active_client = client or httpx.Client(base_url=_normalized_base_url(base_url))
    try:
        checks = [
            ("health", lambda: _check_health(active_client)),
            ("models", lambda: _check_models(active_client)),
            ("chat_stream", lambda: _check_chat_stream(active_client)),
            (
                "bridge_preflight",
                lambda: _check_bridge_preflight(active_client, model),
            ),
        ]
        if include_live_provider:
            checks.append(
                ("live_responses", lambda: _check_live_responses(active_client, model))
            )
        return [_run_check(name, check) for name, check in checks]
    finally:
        if close_client:
            active_client.close()


def run_in_process_smoke_checks(
    *,
    include_live_provider: bool = False,
    model: str = "moonbridge",
) -> list[SmokeResult]:
    """Run smoke checks against an in-process FastAPI app."""

    with TestClient(create_app()) as client:
        return [
            _run_check("health", lambda: _check_testclient_health(client)),
            _run_check("models", lambda: _check_testclient_models(client)),
            _run_check("chat_stream", lambda: _check_testclient_chat_stream(client)),
            _run_check(
                "bridge_preflight",
                lambda: _check_testclient_bridge_preflight(client, model),
            ),
            *(
                [
                    _run_check(
                        "live_responses",
                        lambda: _check_testclient_live_responses(client, model),
                    )
                ]
                if include_live_provider
                else []
            ),
        ]


def main(argv: Sequence[str] | None = None) -> int:
    """Run smoke checks from the command line."""

    parser = argparse.ArgumentParser(description="Smoke-check a Kodeks runtime.")
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000",
        help="Running Kodeks FastAPI base URL.",
    )
    parser.add_argument(
        "--live-provider",
        action="store_true",
        help="Also call /v1/responses, which requires configured provider secrets.",
    )
    parser.add_argument(
        "--in-process",
        action="store_true",
        help="Run against an in-process FastAPI app instead of opening a socket.",
    )
    parser.add_argument(
        "--model",
        default="moonbridge",
        help="Model identifier for bridge/live-provider smoke calls.",
    )
    args = parser.parse_args(argv)

    if args.in_process:
        results = run_in_process_smoke_checks(
            include_live_provider=args.live_provider,
            model=args.model,
        )
    else:
        results = run_smoke_checks(
            args.base_url,
            include_live_provider=args.live_provider,
            model=args.model,
        )
    for result in results:
        status = "ok" if result.ok else "fail"
        print(f"{status}\t{result.name}\t{result.message}")
    return 0 if all(result.ok for result in results) else 1


def _normalized_base_url(base_url: str) -> str:
    """Normalize a user-provided base URL for httpx.Client."""

    return base_url.rstrip("/") or "http://127.0.0.1:8000"


def _run_check(name: str, check: Callable[[], SmokeResult]) -> SmokeResult:
    """Run one smoke check while converting HTTP errors into result rows."""

    try:
        result = check()
    except httpx.HTTPError as exc:
        return SmokeResult(name, False, str(exc))
    return result


def _check_health(client: httpx.Client) -> SmokeResult:
    """Verify the runtime health endpoint is served by Python."""

    response = client.get("/health")
    ok = response.status_code == 200 and response.json() == {
        "ok": True,
        "runtime": "python",
    }
    return SmokeResult("health", ok, _response_message(response))


def _check_testclient_health(client: TestClient) -> SmokeResult:
    """Verify health through FastAPI TestClient."""

    response = client.get("/health")
    ok = response.status_code == 200 and response.json() == {
        "ok": True,
        "runtime": "python",
    }
    return SmokeResult("health", ok, _response_message(response))


def _check_models(client: httpx.Client) -> SmokeResult:
    """Verify the secret-free model catalog keeps its public shape."""

    response = client.get("/api/models")
    ok = response.status_code == 200 and isinstance(response.json().get("models"), list)
    return SmokeResult("models", ok, _response_message(response))


def _check_testclient_models(client: TestClient) -> SmokeResult:
    """Verify the model catalog through FastAPI TestClient."""

    response = client.get("/api/models")
    ok = response.status_code == 200 and isinstance(response.json().get("models"), list)
    return SmokeResult("models", ok, _response_message(response))


def _check_chat_stream(client: httpx.Client) -> SmokeResult:
    """Verify the Python chat route returns SSE without provider side effects."""

    response = client.post(
        "/api/chat/stream",
        json={"session_id": "smoke_missing_input"},
        timeout=30,
    )
    ok = (
        response.status_code == 200
        and "event: error" in response.text
        and "Input is required." in response.text
    )
    return SmokeResult("chat_stream", ok, _response_message(response))


def _check_testclient_chat_stream(client: TestClient) -> SmokeResult:
    """Verify the Python chat route through FastAPI TestClient."""

    response = client.post(
        "/api/chat/stream", json={"session_id": "smoke_missing_input"}
    )
    ok = (
        response.status_code == 200
        and "event: error" in response.text
        and "Input is required." in response.text
    )
    return SmokeResult("chat_stream", ok, _response_message(response))


def _check_bridge_preflight(client: httpx.Client, model: str) -> SmokeResult:
    """Verify bridge preflight returns one known status without using secrets."""

    response = client.post("/api/bridge/preflight", json={"model": model})
    body: dict[str, Any] = response.json() if response.content else {}
    known_status = {"not_required", "unavailable", "ready", "recovered"}
    ok = response.status_code == 200 and body.get("status") in known_status
    return SmokeResult("bridge_preflight", ok, _response_message(response))


def _check_testclient_bridge_preflight(client: TestClient, model: str) -> SmokeResult:
    """Verify bridge preflight through FastAPI TestClient."""

    response = client.post("/api/bridge/preflight", json={"model": model})
    body: dict[str, Any] = response.json() if response.content else {}
    known_status = {"not_required", "unavailable", "ready", "recovered"}
    ok = response.status_code == 200 and body.get("status") in known_status
    return SmokeResult("bridge_preflight", ok, _response_message(response))


def _check_live_responses(client: httpx.Client, model: str) -> SmokeResult:
    """Verify the live Responses-compatible route when provider secrets exist."""

    response = client.post(
        "/v1/responses",
        json={"model": model, "input": "hello", "stream": False},
        timeout=60,
    )
    ok = 200 <= response.status_code < 300
    return SmokeResult("live_responses", ok, _response_message(response))


def _check_testclient_live_responses(client: TestClient, model: str) -> SmokeResult:
    """Verify live Responses-compatible route through FastAPI TestClient."""

    response = client.post(
        "/v1/responses",
        json={"model": model, "input": "hello", "stream": False},
    )
    ok = 200 <= response.status_code < 300
    return SmokeResult("live_responses", ok, _response_message(response))


def _response_message(response: SmokeResponse) -> str:
    """Format a concise HTTP response summary for smoke logs."""

    if not response.content:
        return f"HTTP {response.status_code}"
    try:
        body = response.json()
    except ValueError:
        text = response.text[:120].replace("\n", " ")
        return f"HTTP {response.status_code}: {text}"
    if isinstance(body, dict):
        summary = body.get("status") or body.get("runtime") or body.get("error")
        if summary is not None:
            return f"HTTP {response.status_code}: {summary}"
    return f"HTTP {response.status_code}"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
