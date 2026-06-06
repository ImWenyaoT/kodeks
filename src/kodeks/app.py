"""FastAPI entrypoint for the Python Kodeks runtime."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .api.approval_routes import register_approval_routes
from .api.bridge_routes import (
    check_chat_completions_upstream as _check_chat_completions_upstream,
)
from .api.bridge_routes import (
    register_bridge_routes,
)
from .api.chat_routes import register_chat_routes
from .api.session_routes import register_session_routes
from .api.workspace_routes import register_workspace_routes
from .config import load_configured_model_catalog
from .responses_runtime import ResponsesEventFactory
from .storage import KodeksDatabase


def _cors_origins(env: Mapping[str, str]) -> list[str]:
    """Read allowed browser origins for direct Python runtime API calls."""

    raw = env.get("KODEKS_CORS_ORIGINS")
    if raw is not None:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]
    return []


def create_app(
    responses_event_factory: ResponsesEventFactory | None = None,
) -> FastAPI:
    """Create the Python runtime app with stable HTTP routes."""

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

    register_bridge_routes(
        app,
        read_json_body=_json_body,
        check_upstream=_check_chat_completions_upstream,
    )
    register_session_routes(
        app,
        read_json_body=_json_body,
        database=database,
        resolve_workspace_root=resolve_workspace_root,
    )
    register_workspace_routes(app, resolve_workspace_root=resolve_workspace_root)
    register_approval_routes(
        app,
        read_json_body=_json_body,
        database=database,
        resolve_workspace_root=resolve_workspace_root,
    )
    register_chat_routes(
        app,
        read_json_body=_json_body,
        database=database,
        resolve_workspace_root=resolve_workspace_root,
        responses_event_factory=responses_event_factory,
    )

    # Mount the built frontend LAST so the API routes above take precedence and
    # the static mount only serves the SPA shell (index.html via html=True) plus
    # the _next/ asset bundles as a catch-all. Guard with is_dir() so a fresh
    # checkout without a built bundle still imports and serves /api + /health
    # instead of crashing on StaticFiles' default check_dir=True.
    static_dir = Path(__file__).with_name("static")
    if static_dir.is_dir():
        app.mount(
            "/", StaticFiles(directory=str(static_dir), html=True), name="static"
        )

    return app


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


app = create_app()
