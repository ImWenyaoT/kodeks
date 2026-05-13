from fastapi import APIRouter

from kodeks.services.workspace_service import list_files

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


@router.get("/files")
async def get_workspace_files() -> dict[str, list[str]]:
    """Return files in the workspace."""
    return {"files": list_files()}