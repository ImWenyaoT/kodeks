# q1: main.py 在架构里负责什么？
# a1: 它只组装 FastAPI app 和 route，不承载 agent runtime、provider、tool、session 的业务逻辑。
# q2: 这和新参考源规则有什么关系？
# a2: /src 和 opencode 都把入口层和 runtime/agent 编排层分开；kodeks 用 FastAPI 落地这个边界，DeepSeek SDK 细节只在 outbound provider adapter 里出现。

from dotenv import load_dotenv
from fastapi import FastAPI

from kodeks.api.routes.approvals import router as approvals_router
from kodeks.api.routes.chat import router as chat_router
from kodeks.api.routes.health import router as health_router
from kodeks.api.routes.shell import router as shell_router
from kodeks.api.routes.workspace import router as workspace_router

load_dotenv()  # Load environment variables from .env file


def create_app() -> FastAPI:
    """Create and configure the FastAPI app."""
    app = FastAPI()

    app.include_router(chat_router)
    app.include_router(health_router)
    app.include_router(workspace_router)
    app.include_router(shell_router)
    app.include_router(approvals_router)

    return app


app = create_app()
