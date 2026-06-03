"""Shared FastAPI route dependency types."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request

from ..storage import KodeksDatabase

DatabaseProvider = Callable[[], KodeksDatabase]
JsonBodyReader = Callable[[Request], Awaitable[dict[str, Any]]]
WorkspaceRootResolver = Callable[[], str]
