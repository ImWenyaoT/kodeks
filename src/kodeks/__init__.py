"""Python runtime package for Kodeks."""

from typing import Any


def create_app() -> Any:
    """Create the FastAPI app while keeping package import dependency-light."""

    from .app import create_app as create_fastapi_app

    return create_fastapi_app()

__all__ = ["create_app"]
