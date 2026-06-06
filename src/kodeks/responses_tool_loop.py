"""Responses API function-call continuation loop helpers."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypedDict

from .storage import KodeksDatabase
from .tools.types import (
    ToolArguments,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolExecutionStatus,
)

RuntimeToolStatus = Literal["ok", "approval_required", "error"]


class ToolRegistryLike(Protocol):
    """Small registry interface required by the Responses tool loop."""

    def has(self, tool_name: str) -> bool:
        """Return whether a tool is locally registered."""

    def execute(
        self,
        tool_name: str,
        arguments: ToolArguments,
        context: ToolExecutionContext | None = None,
    ) -> ToolExecutionResult:
        """Execute one registered local tool."""


class ToolCallRecord(TypedDict):
    """Persisted assistant tool-call record used for continuation replay."""

    id: str
    name: str
    args: dict[str, Any]


class ToolMessageRecord(TypedDict):
    """Persisted tool output record used for continuation replay."""

    toolCallId: str
    name: str
    output: str


@dataclass
class ToolRoundState:
    """Track tool calls that decide whether the current model turn continues."""

    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    tool_messages: list[ToolMessageRecord] = field(default_factory=list)
    reasoning_content: str | None = None
    waiting_for_approval: bool = False
    halt_tool_loop: bool = False


async def handle_output_item(
    item: object,
    registry: ToolRegistryLike,
    database: KodeksDatabase,
    workspace_root: str,
    runtime_env: Mapping[str, str | None],
    session_id: str,
    tool_state: ToolRoundState,
) -> AsyncIterator[dict[str, Any]]:
    """Execute completed Responses function_call items through local tools."""

    if not isinstance(item, dict) or item.get("type") != "function_call":
        return
    tool_call_id = str(item.get("call_id") or item.get("id") or "")
    tool_name = str(item.get("name") or "")
    tool_arguments = _parse_tool_arguments(item.get("arguments"))
    yield {
        "type": "assistant_status",
        "message": f"Using {tool_name}",
        "session_id": session_id,
    }
    yield {
        "type": "tool_call",
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "tool_arguments": tool_arguments,
        "session_id": session_id,
    }
    database.audit_log.record(
        session_id,
        "tool_called",
        {
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "arguments": tool_arguments,
        },
    )
    if not registry.has(tool_name):
        output = f"Unknown tool requested by model: {tool_name}"
        tool_state.halt_tool_loop = True
        database.audit_log.record(
            session_id,
            "tool_failed",
            {
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "reason": output,
            },
        )
        yield {
            "type": "tool_result",
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "tool_status": "error",
            "tool_output": output,
            "session_id": session_id,
        }
        yield _error_event(output, session_id, "model_requested_unknown_tool")
        return
    result = registry.execute(
        tool_name, tool_arguments, ToolExecutionContext(session_id, tool_call_id)
    )
    mapped_status = _map_tool_status(result.status)
    tool_output = result.output
    if mapped_status == "ok":
        tool_output = database.memories.compact_tool_result(
            workspace_root=workspace_root,
            session_id=session_id,
            tool_call_id=tool_call_id or None,
            tool_name=tool_name,
            output=result.output,
            threshold_bytes=_artifact_threshold_bytes(runtime_env),
        )
    parsed_output = parse_json_object(tool_output)
    if isinstance(item.get("reasoning_content"), str):
        tool_state.reasoning_content = str(item["reasoning_content"])
    if mapped_status != "approval_required":
        tool_state.tool_calls.append(
            {"id": tool_call_id, "name": tool_name, "args": dict(tool_arguments)}
        )
        tool_state.tool_messages.append(
            {
                "toolCallId": tool_call_id,
                "name": tool_name,
                "output": tool_output,
            }
        )
    yield {
        "type": "tool_result",
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "tool_status": mapped_status,
        "tool_output": tool_output,
        "session_id": session_id,
    }
    database.audit_log.record(
        session_id,
        "tool_result",
        {
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "status": mapped_status,
        },
    )
    if mapped_status == "approval_required":
        tool_state.waiting_for_approval = True
        yield {
            "type": "approval_required",
            "approval_id": str(parsed_output.get("approvalId") or ""),
            "tool_call_id": tool_call_id,
            "message": str(parsed_output.get("reason") or "Command requires approval"),
            "session_id": session_id,
        }


def append_tool_continuation_messages(
    database: KodeksDatabase,
    session_id: str,
    assistant_text: str,
    reasoning_content: str | None,
    tool_calls: list[ToolCallRecord],
    tool_messages: list[ToolMessageRecord],
) -> None:
    """Persist assistant tool-call and tool output messages for continuation."""

    assistant_content: dict[str, Any] = {
        "text": assistant_text,
        "toolCalls": tool_calls,
    }
    if reasoning_content:
        assistant_content["reasoningContent"] = reasoning_content
    database.sessions.append_message(session_id, "assistant", assistant_content)
    for message in tool_messages:
        database.sessions.append_message(
            session_id,
            "tool",
            {
                "text": message["output"],
                "toolCallId": message["toolCallId"],
                "name": message["name"],
            },
        )


def parse_json_object(value: str) -> dict[str, Any]:
    """Parse a JSON object from model/tool output."""

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _artifact_threshold_bytes(env: Mapping[str, str | None]) -> int:
    """Read the memory artifact threshold for large tool outputs."""

    raw = env.get("KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES")
    if raw is None:
        return 4096
    try:
        value = int(raw)
    except ValueError:
        return 4096
    return max(1, value)


def _parse_tool_arguments(value: object) -> dict[str, Any]:
    """Parse Responses function-call arguments from JSON or mapping."""

    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _map_tool_status(status: ToolExecutionStatus) -> RuntimeToolStatus:
    """Map registry statuses into the runtime event status contract."""

    if status == "completed":
        return "ok"
    if status == "approval_required":
        return "approval_required"
    return "error"


def _error_event(
    message: str, session_id: str, code: str = "runtime_error"
) -> dict[str, Any]:
    """Build a runtime error event."""

    return {
        "type": "error",
        "message": message,
        "code": code,
        "session_id": session_id,
    }
