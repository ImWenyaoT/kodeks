"""FastAPI routes for MoonBridge diagnostics and Responses translation."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, cast

import httpx2
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ..api.sse import sse_frame
from ..config import (
    ModelConfigurationError,
    load_model_runtime_env,
    read_chat_completions_api_key,
    read_chat_completions_config,
    resolve_model_client_options,
)
from ..providers.bridge import (
    fetch_chat_completions_stream,
    from_deepseek_stream,
    to_deepseek_chat_request,
)

JsonBodyReader = Callable[[Request], Awaitable[dict[str, Any]]]
UpstreamChecker = Callable[[str], Awaitable[dict[str, str] | None]]


def register_bridge_routes(
    app: FastAPI,
    *,
    read_json_body: JsonBodyReader,
    check_upstream: UpstreamChecker,
) -> None:
    """Register MoonBridge-related routes on the FastAPI app."""

    @app.post("/api/bridge/preflight")
    async def bridge_preflight(request: Request) -> dict[str, object]:
        """Report MoonBridge readiness using Python config parity logic."""

        body = await read_json_body(request)
        requested_provider = _requested_provider(body.get("provider"))
        checked_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        try:
            model_env = load_model_runtime_env(os.environ, body.get("model"))
            model_options = resolve_model_client_options(
                model_env, None, body.get("provider")
            )
        except ModelConfigurationError as exc:
            return {
                "status": "unavailable",
                "provider": requested_provider,
                "code": exc.code,
                "reason": str(exc),
                "checkedAt": checked_at,
            }
        if model_options is None:
            return {
                "status": "unavailable",
                "provider": requested_provider,
                "code": "model_provider_missing",
                "reason": "No DeepSeek provider is configured. Set KODEKS_CHAT_COMPLETIONS_* for the MoonBridge route.",
                "checkedAt": checked_at,
            }
        upstream = read_chat_completions_config(model_env)
        base = {
            "provider": requested_provider,
            "resolvedProvider": "moonbridge",
            "bridgeBaseURL": model_options["baseURL"],
            "bridgeModel": model_options["model"],
            "upstreamBaseURL": upstream["baseURL"],
            "upstreamModel": upstream["model"],
            "checkedAt": checked_at,
        }
        if upstream["missing"]:
            missing = cast(list[str], upstream["missing"])
            return {
                **base,
                "status": "unavailable",
                "code": "moonbridge_upstream_missing",
                "reason": (
                    "Missing upstream Chat Completions configuration: "
                    f"{', '.join(missing)}."
                ),
            }
        upstream_error = await check_upstream(str(upstream["baseURL"]))
        if upstream_error is not None:
            return {
                **base,
                "status": "unavailable",
                "code": upstream_error["code"],
                "reason": upstream_error["reason"],
            }
        return {**base, "status": "ready"}

    @app.get("/bridge/health")
    @app.get("/v1/models")
    @app.get("/models")
    def bridge_models() -> dict[str, object]:
        """Expose bridge health/model aliases for local smoke tests."""

        models = [
            {
                "id": os.environ.get("KODEKS_BRIDGE_MODEL") or "bridge",
                "object": "model",
                "owned_by": "kodeks",
            },
            {"id": "moonbridge", "object": "model", "owned_by": "kodeks"},
        ]
        return {"object": "list", "data": models, "models": models}

    @app.post("/v1/responses")
    @app.post("/responses")
    async def responses_bridge(request: Request) -> Response:
        """Translate Responses-shaped traffic to Chat Completions SSE."""

        env = load_model_runtime_env(os.environ)
        api_key = read_chat_completions_api_key(env)
        if not api_key:
            return JSONResponse(
                {
                    "error": {
                        "message": "KODEKS_CHAT_COMPLETIONS_API_KEY is required for the DeepSeek/MoonBridge route."
                    }
                },
                status_code=500,
            )
        upstream = read_chat_completions_config(env)
        if upstream["missing"]:
            missing = cast(list[str], upstream["missing"])
            return JSONResponse(
                {
                    "error": {
                        "message": (
                            "Missing upstream Chat Completions configuration: "
                            f"{', '.join(missing)}."
                        )
                    }
                },
                status_code=500,
            )
        body = await read_json_body(request)
        payload = to_deepseek_chat_request(body, str(upstream["model"]))

        async def frames() -> AsyncIterator[str]:
            """Stream converted Responses events as SSE frames."""

            async for event in from_deepseek_stream(
                fetch_chat_completions_stream(payload, api_key, env),
                model=str(body.get("model") or "bridge"),
            ):
                yield sse_frame(str(event["type"]), event)
            yield "data: [DONE]\n\n"

        return StreamingResponse(frames(), media_type="text/event-stream")


async def check_chat_completions_upstream(base_url: str) -> dict[str, str] | None:
    """Check that the configured Chat Completions upstream is reachable."""

    try:
        async with httpx2.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{base_url.rstrip('/')}/models")
    except httpx2.HTTPError as exc:
        return {
            "code": "moonbridge_upstream_unreachable",
            "reason": (
                "Configured Chat Completions upstream is unreachable: "
                f"{type(exc).__name__}."
            ),
        }
    if response.status_code >= 400:
        return {
            "code": "moonbridge_upstream_unhealthy",
            "reason": (
                "Configured Chat Completions upstream returned "
                f"HTTP {response.status_code}."
            ),
        }
    return None


def _requested_provider(value: object) -> str:
    """Return the diagnostic provider label used by bridge preflight."""

    return value if value == "moonbridge" else "auto"
