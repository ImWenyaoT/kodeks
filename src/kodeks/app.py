"""FastAPI entrypoint for the incremental Python Kodeks runtime."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

import httpx2
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from .agents_runtime import AgentsSdkRunner
from .api.sse import sse_frame
from .api.ui_transport import to_ui_transport_payload
from .config import (
    ModelConfigurationError,
    load_configured_model_catalog,
    load_model_runtime_env,
    read_chat_completions_api_key,
    read_chat_completions_config,
    resolve_model_client_options,
)
from .providers.bridge import (
    fetch_chat_completions_stream,
    from_deepseek_stream,
    to_deepseek_chat_request,
)
from .runtime import (
    ResponsesEventFactory,
    run_python_chat_turn,
)
from .storage import (
    ApprovalAlreadyResolvedError,
    ApprovalNotFoundError,
    KodeksDatabase,
)
from .workspace import (
    ShellCommandTimeoutError,
    WorkspaceService,
    run_approved_command,
)


def _cors_origins(env: Mapping[str, str]) -> list[str]:
    """Read allowed browser origins for direct Python runtime API calls."""

    raw = env.get("KODEKS_CORS_ORIGINS")
    if raw is not None:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return []


def _static_index_html() -> str:
    """Read the Python-served browser shell for local interactive use."""

    return (Path(__file__).with_name("static") / "index.html").read_text(
        encoding="utf-8"
    )


def create_app(
    responses_event_factory: ResponsesEventFactory | None = None,
    agents_runner: AgentsSdkRunner | None = None,
) -> FastAPI:
    """Create the Python runtime app with compatibility routes."""

    state: dict[str, KodeksDatabase | None] = {"database": None}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Close SQLite when the FastAPI process shuts down."""

        try:
            yield
        finally:
            current = state["database"]
            if current is not None:
                current.close()

    app = FastAPI(title="Kodeks Python Runtime", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(os.environ),
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    def database() -> KodeksDatabase:
        current = state["database"]
        if current is not None:
            return current
        db_path = os.environ.get("KODEKS_DB_PATH") or str(
            Path(resolve_workspace_root()) / ".kodeks" / "kodeks.sqlite3"
        )
        current = KodeksDatabase(db_path)
        state["database"] = current
        return current

    @app.get("/")
    def index() -> HTMLResponse:
        """Serve the minimal Python-native Kodeks UI."""

        return HTMLResponse(_static_index_html())

    @app.get("/favicon.ico")
    def favicon() -> Response:
        """Return an empty favicon response so browsers keep the console clean."""

        return Response(status_code=204)

    @app.get("/health")
    def health() -> dict[str, object]:
        """Return readiness for deployment manager and local smoke checks."""

        return {"ok": True, "runtime": "python"}

    @app.get("/api/models")
    def models() -> JSONResponse:
        """Return the configured model catalog without secrets."""

        catalog = load_configured_model_catalog(os.environ)
        return JSONResponse(catalog.model_dump(by_alias=True, exclude_none=True))

    @app.get("/api/sessions")
    def list_sessions() -> dict[str, object]:
        """List sessions with active plans, matching the Next route shape."""

        db = database()
        sessions = []
        for session in db.sessions.list_sessions():
            payload = session.model_dump(by_alias=True)
            plan = db.plans.get_active_by_session(session.id)
            payload["activePlan"] = (
                None if plan is None else plan.model_dump(by_alias=True)
            )
            sessions.append(payload)
        return {"sessions": sessions}

    @app.post("/api/sessions")
    async def create_session(request: Request) -> JSONResponse:
        """Create one session record for resume and mode tracking."""

        body = await _json_body(request)
        session = database().sessions.create_session(
            title=_string(body.get("title")) or "Kodeks session",
            mode="plan" if body.get("mode") == "plan" else "act",
            session_id=_string(body.get("session_id")),
            workspace_root=resolve_workspace_root(),
        )
        return JSONResponse(
            {"session": session.model_dump(by_alias=True)}, status_code=201
        )

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: str) -> dict[str, object]:
        """Read one session plus transcript for chat resume."""

        session_id = session_id.strip()
        if not session_id:
            raise HTTPException(status_code=400, detail="Missing session id.")
        db = database()
        session = db.sessions.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        return {
            "session": session.model_dump(by_alias=True),
            "messages": [
                message.model_dump(by_alias=True)
                for message in db.sessions.get_transcript(session_id)
            ],
        }

    @app.get("/api/workspace/files")
    def workspace_files() -> dict[str, object]:
        """List visible files for the frontend file picker."""

        return {
            "files": WorkspaceService(resolve_workspace_root()).list_files(limit=500)
        }

    @app.get("/api/approvals/{approval_id}")
    def get_approval(approval_id: str) -> dict[str, object]:
        """Read one approval record."""

        try:
            approval = database().approvals.get_approval(approval_id)
        except ApprovalNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"approval": approval.model_dump(by_alias=True)}

    @app.post("/api/approvals/{approval_id}")
    async def decide_approval(approval_id: str, request: Request) -> JSONResponse:
        """Approve or reject one pending approval, executing approved shell once."""

        body = await _json_body(request)
        decision = body.get("decision")
        db = database()
        try:
            if decision == "reject":
                approval = db.approvals.reject(
                    approval_id,
                    _string(body.get("reason")) or "Rejected by user",
                )
                db.audit_log.record(
                    approval.session_id,
                    "approval_rejected",
                    {"approvalId": approval.id},
                )
                return JSONResponse({"approval": approval.model_dump(by_alias=True)})
            if decision != "approve":
                return JSONResponse(
                    {"error": 'Invalid decision. Expected "approve" or "reject".'},
                    status_code=400,
                )
            pending = db.approvals.get_approval(approval_id)
            command = _approved_command(pending.command)
            if command is None:
                return JSONResponse(
                    {"error": "Approval does not contain an executable command."},
                    status_code=400,
                )
            approved = db.approvals.approve(approval_id)
            result = run_approved_command(command, resolve_workspace_root())
            executed = db.approvals.mark_executed(approval_id)
            db.audit_log.record(
                approved.session_id,
                "approval_executed",
                {
                    "approvalId": approved.id,
                    "command": command,
                    "exitCode": result.exit_code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                },
            )
            return JSONResponse(
                {
                    "approval": executed.model_dump(by_alias=True),
                    "result": result.to_wire(),
                }
            )
        except ApprovalNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ApprovalAlreadyResolvedError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ShellCommandTimeoutError as exc:
            raise HTTPException(status_code=408, detail=str(exc)) from exc

    @app.post("/api/bridge/preflight")
    async def bridge_preflight(request: Request) -> dict[str, object]:
        """Report MoonBridge readiness using Python config parity logic."""

        body = await _json_body(request)
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
        upstream_error = await _check_chat_completions_upstream(str(upstream["baseURL"]))
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
                        "message": "KODEKS_CHAT_COMPLETIONS_API_KEY is required. Legacy DEEPSEEK_* and KODEKS_BRIDGE_DEEPSEEK_* keys have been removed."
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
        body = await _json_body(request)
        payload = to_deepseek_chat_request(body, str(upstream["model"]))

        async def frames() -> AsyncIterator[str]:
            async for event in from_deepseek_stream(
                fetch_chat_completions_stream(payload, api_key, env),
                model=str(body.get("model") or "bridge"),
            ):
                yield sse_frame(str(event["type"]), event)
            yield "data: [DONE]\n\n"

        return StreamingResponse(frames(), media_type="text/event-stream")

    @app.post("/api/chat/stream")
    async def chat_stream(request: Request) -> StreamingResponse:
        """Run one Python chat turn and stream Kodeks runtime events."""

        body = await _json_body(request)

        async def frames() -> AsyncIterator[str]:
            async for event in run_python_chat_turn(
                body,
                database(),
                resolve_workspace_root(),
                os.environ,
                responses_event_factory,
                agents_runner,
            ):
                yield sse_frame(str(event["type"]), event)

        return StreamingResponse(frames(), media_type="text/event-stream")

    @app.post("/api/chat/ui")
    async def chat_ui_stream(request: Request) -> StreamingResponse:
        """Run one Python chat turn and stream UI transport adapter events."""

        body = await _json_body(request)

        async def frames() -> AsyncIterator[str]:
            async for event in run_python_chat_turn(
                body,
                database(),
                resolve_workspace_root(),
                os.environ,
                responses_event_factory,
                agents_runner,
            ):
                payload = to_ui_transport_payload(event)
                if payload is not None:
                    yield sse_frame(str(payload["type"]), payload)

        return StreamingResponse(frames(), media_type="text/event-stream")

    return app


app = create_app()


def resolve_workspace_root() -> str:
    """Resolve the authorized workspace root for the Python service."""

    if os.environ.get("KODEKS_WORKSPACE_ROOT"):
        return str(Path(os.environ["KODEKS_WORKSPACE_ROOT"]).resolve())
    return str(Path.cwd().resolve())


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _approved_command(value: object) -> str | None:
    if isinstance(value, dict):
        command = value.get("command")
        if isinstance(command, str) and command.strip():
            return command.strip()
    return None


def _requested_provider(value: object) -> str:
    """Return the diagnostic provider label used by the TypeScript preflight."""

    return value if value == "moonbridge" else "auto"


async def _check_chat_completions_upstream(base_url: str) -> dict[str, str] | None:
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
