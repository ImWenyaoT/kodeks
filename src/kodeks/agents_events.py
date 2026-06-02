"""OpenAI Agents SDK stream event normalization."""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentsSdkApprovalMetadata:
    """Durable approval metadata needed to map SDK interruptions to UI events."""

    approval_id: str
    tool_call_id: str
    reason: str


def read_agents_sdk_text_delta(event: object) -> str | None:
    """Read streaming text deltas from raw Agents SDK model events."""

    data = _dict_content(_dict_content(event).get("data"))
    if data.get("type") in {"output_text_delta", "response.output_text.delta"}:
        delta = data.get("delta")
        return delta if isinstance(delta, str) else None
    return None


def read_agents_sdk_tool_call(event: object) -> dict[str, Any] | None:
    """Read function call starts from Agents SDK run-item events."""

    record = _dict_content(event)
    if record.get("type") != "run_item_stream_event" or record.get("name") != "tool_called":
        return None
    item = _dict_content(record.get("item"))
    raw_item = _dict_content(item.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(item)
    name = _string(raw_item.get("name")) or _string(item.get("name")) or "tool"
    return {
        "id": tool_call_id or _new_tool_call_id(),
        "name": name,
        "args": parse_tool_arguments(raw_item.get("arguments")),
    }


def read_agents_sdk_tool_result(event: object) -> dict[str, Any] | None:
    """Read function call outputs from Agents SDK run-item events."""

    record = _dict_content(event)
    if record.get("type") != "run_item_stream_event" or record.get("name") != "tool_output":
        return None
    item = _dict_content(record.get("item"))
    raw_item = _dict_content(item.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(item)
    name = _string(raw_item.get("name")) or _string(item.get("name")) or "tool"
    output = _stringify_tool_output(item.get("output", raw_item.get("output")))
    parsed = _parse_tool_output(output)
    return {
        "id": tool_call_id or _new_tool_call_id(),
        "name": name,
        "output": output,
        "status": "approval_required"
        if parsed.get("approvalRequired") is True
        else "ok",
    }


def read_agents_sdk_approval(
    event: object, approval_state: Mapping[str, AgentsSdkApprovalMetadata]
) -> AgentsSdkApprovalMetadata | None:
    """Map SDK approval-request stream events back to durable Kodeks approvals."""

    record = _dict_content(event)
    if (
        record.get("type") != "run_item_stream_event"
        or record.get("name") != "tool_approval_requested"
    ):
        return None
    return approval_from_sdk_item(record.get("item"), approval_state)


def approval_from_sdk_item(
    item: object, approval_state: Mapping[str, AgentsSdkApprovalMetadata]
) -> AgentsSdkApprovalMetadata | None:
    """Resolve a SDK interruption item to known approval metadata or fallback ids."""

    record = _dict_content(item)
    raw_item = _dict_content(record.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(record)
    if tool_call_id is None:
        return None
    return approval_state.get(
        tool_call_id,
        AgentsSdkApprovalMetadata(
            approval_id=tool_call_id,
            tool_call_id=tool_call_id,
            reason="Tool call requires approval",
        ),
    )


def parse_tool_arguments(value: object) -> dict[str, Any]:
    """Parse SDK tool arguments from a JSON string or mapping."""

    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _dict_content(value: object) -> dict[str, Any]:
    """Return dictionaries from plain mappings or pydantic-style SDK objects."""

    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(by_alias=True, exclude_none=True)
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _parse_tool_output(output: str) -> dict[str, Any]:
    """Parse JSON tool output for approval status extraction."""

    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _stringify_tool_output(output: object) -> str:
    """Serialize SDK tool output to the existing UI string contract."""

    if isinstance(output, str):
        return output
    if output is None:
        return ""
    return json.dumps(output, separators=(",", ":"))


def _read_tool_call_id(item: Mapping[str, Any]) -> str | None:
    """Read tool call ids across SDK and wire-format naming variants."""

    for key in ("callId", "call_id", "id", "toolCallId"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _string(value: object) -> str | None:
    """Return non-empty strings for optional event fields."""

    return value if isinstance(value, str) and value else None


def _new_tool_call_id() -> str:
    """Generate a stable-prefix fallback tool call id."""

    return f"tool_{uuid.uuid4().hex}"
