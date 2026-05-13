from fastapi import FastAPI

from kodeks.api.routes.health import router as health_router
from kodeks.api.routes.workspace import router as workspace_router


def create_app() -> FastAPI:
    """Create and configure the FastAPI app."""
    app = FastAPI()

    app.include_router(health_router)
    app.include_router(workspace_router)

    return app


app = create_app()
