from dotenv import load_dotenv
from fastapi import FastAPI

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

    return app


app = create_app()
