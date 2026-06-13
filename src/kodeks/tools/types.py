"""Shared tool registry contracts."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..storage import KodeksDatabase
from ..workspace import WorkspaceService
from .schemas import ToolDefinition

ToolArguments = Mapping[str, Any]
ToolExecutionStatus = Literal["completed", "failed", "approval_required"]


@dataclass(frozen=True)
class ToolExecutionContext:
    """Carries session and tool-call ids into approval and audit records."""

    session_id: str | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolExecutionResult:
    """Model-facing tool execution result."""

    status: ToolExecutionStatus
    output: str


@dataclass(frozen=True)
class ToolRegistryServices:
    """Service bundle used by deterministic local tool handlers."""

    workspace: WorkspaceService
    database: KodeksDatabase
    environment: Mapping[str, str | None] | None = None


@dataclass(frozen=True)
class RegisteredTool:
    """One registered tool definition and its Python handler."""

    definition: ToolDefinition
    read_only: bool
    mutating: bool
    handler: Callable[[ToolArguments, ToolExecutionContext], ToolExecutionResult]
