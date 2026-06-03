"""FastAPI routes for workspace browsing."""

from __future__ import annotations

from fastapi import FastAPI

from ..workspace import WorkspaceService
from .dependencies import WorkspaceRootResolver


def register_workspace_routes(
    app: FastAPI,
    *,
    resolve_workspace_root: WorkspaceRootResolver,
) -> None:
    """Register workspace file discovery routes."""

    @app.get("/api/workspace/files")
    def workspace_files() -> dict[str, object]:
        """List visible files for the frontend file picker."""

        return {
            "files": WorkspaceService(resolve_workspace_root()).list_files(limit=500)
        }
