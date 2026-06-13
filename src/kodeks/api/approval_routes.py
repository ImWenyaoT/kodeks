"""FastAPI routes for approval reads and decisions."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from ..storage import (
    ApprovalAlreadyResolvedError,
    ApprovalNotFoundError,
)
from ..workspace import ShellCommandTimeoutError, run_approved_command
from .dependencies import DatabaseProvider, JsonBodyReader, WorkspaceRootResolver


def register_approval_routes(
    app: FastAPI,
    *,
    read_json_body: JsonBodyReader,
    database: DatabaseProvider,
    resolve_workspace_root: WorkspaceRootResolver,
) -> None:
    """Register approval lookup and decision routes."""

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

        body = await read_json_body(request)
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


def _approved_command(value: object) -> str | None:
    """Read the executable command payload from an approval record."""

    if isinstance(value, dict):
        command = value.get("command")
        if isinstance(command, str) and command.strip():
            return command.strip()
    return None


def _string(value: object) -> str | None:
    """Return a stripped non-empty string or None."""

    return value.strip() if isinstance(value, str) and value.strip() else None
