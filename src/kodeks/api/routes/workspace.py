# q1: 为什么 workspace 文件能力要先做成 API，而不是直接塞进 OpenAI tool calling？
# a1: 先做 API 能独立验证产品能力和安全边界；等 API 稳定后，再把同一套 service 暴露给 agent tools。
# q2: route 层和 service 层怎么分工？
# a2: route 层负责 HTTP 入参、状态码和错误映射；service 层负责真正的文件系统规则和安全策略。

from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, Query

from kodeks.services.workspace_service import list_files, read_file, write_file

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


@router.get("/files")
async def get_workspace_files() -> dict[str, list[str]]:
    """Return files in the workspace."""
    return {"files": list_files()}


@router.get("/read")
async def read_workspace_file(path: str = Query(...)) -> dict[str, str]:
    """Read a file from the workspace."""
    try:
        content = read_file(path)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return {
        "path": path,
        "content": content,
    }


class WriteFileRequest(BaseModel):
    path: str
    content: str


@router.post("/write")
async def write_workspace_file(request: WriteFileRequest) -> dict[str, str]:
    """Write a file inside the workspace."""
    try:
        write_file(request.path, request.content)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    return {
        "path": request.path,
        "status": "written",
    }
