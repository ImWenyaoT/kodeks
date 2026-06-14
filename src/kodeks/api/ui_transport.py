"""UI transport event mapping for the Python Kodeks runtime."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def to_ui_transport_payload(event: Mapping[str, Any]) -> dict[str, Any] | None:
    """Map Python runtime events into the experimental UI transport shape."""

    event_type = event.get("type")
    session_id = str(event.get("session_id") or "")
    if event_type == "session_created":
        return {"type": "session", "sessionId": session_id}
    if event_type == "assistant_status":
        return {
            "type": "status",
            "message": str(event.get("message") or ""),
            "sessionId": session_id,
        }
    if event_type == "text_delta":
        return {
            "type": "text-delta",
            "delta": str(event.get("delta") or ""),
            "sessionId": session_id,
        }
    if event_type == "tool_call":
        return {
            "type": "tool-call",
            "toolCallId": str(event.get("tool_call_id") or ""),
            "toolName": str(event.get("tool_name") or ""),
            "args": event.get("tool_arguments") or {},
            "sessionId": session_id,
        }
    if event_type == "tool_result":
        return {
            "type": "tool-result",
            "toolCallId": str(event.get("tool_call_id") or ""),
            "toolName": str(event.get("tool_name") or ""),
            "result": str(event.get("tool_output") or ""),
            "status": str(event.get("tool_status") or ""),
            "sessionId": session_id,
        }
    if event_type == "approval_required":
        return {
            "type": "approval-required",
            "approvalId": str(event.get("approval_id") or ""),
            "toolCallId": str(event.get("tool_call_id") or ""),
            "message": str(event.get("message") or ""),
            "command": str(event.get("command") or ""),
            "commandHash": str(event.get("command_hash") or ""),
            "sessionId": session_id,
        }
    if event_type == "response_completed":
        return {
            "type": "finish",
            "responseId": str(event.get("response_id") or ""),
            "sessionId": session_id,
        }
    if event_type == "error":
        return {
            "type": "error",
            "errorText": str(event.get("message") or ""),
            "code": event.get("code"),
            "sessionId": session_id,
        }
    return None
