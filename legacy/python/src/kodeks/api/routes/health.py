# q1: health route 为什么保持这么薄？
# a1: 它只验证 FastAPI app 可启动，不参与 agent runtime；这让基础服务健康和模型/provider 状态解耦。

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    """Return service health status."""
    return {"status": "ok"}
