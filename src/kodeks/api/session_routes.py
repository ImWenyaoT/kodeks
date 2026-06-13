"""FastAPI routes for Kodeks session records and transcripts."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .dependencies import DatabaseProvider, JsonBodyReader, WorkspaceRootResolver


def register_session_routes(
    app: FastAPI,
    *,
    read_json_body: JsonBodyReader,
    database: DatabaseProvider,
    resolve_workspace_root: WorkspaceRootResolver,
) -> None:
    """Register session list, create, and transcript routes."""

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

        body = await read_json_body(request)
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


def _string(value: object) -> str | None:
    """Return a stripped non-empty string or None."""

    return value.strip() if isinstance(value, str) and value.strip() else None
