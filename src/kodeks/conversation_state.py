"""Conversation-state replay adapters for Responses-compatible model calls."""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

from .contracts import StoredMessage


def build_responses_input_from_transcript(
    database: Any, session_id: str
) -> list[dict[str, Any]]:
    """Convert persisted transcript rows into Responses-compatible input items."""

    return build_responses_input_from_messages(database.sessions.get_transcript(session_id))


def build_responses_input_from_messages(
    messages: Iterable[StoredMessage],
) -> list[dict[str, Any]]:
    """Convert stored transcript messages into Responses-compatible input items."""

    items: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "tool":
            content = _dict_content(message.content)
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": str(content.get("toolCallId") or ""),
                    "output": _content_text(message.content),
                }
            )
            continue
        if message.role == "assistant":
            content = _dict_content(message.content)
            tool_calls = content.get("toolCalls")
            if isinstance(tool_calls, list) and tool_calls:
                text = _content_text(message.content)
                if text:
                    items.append(_assistant_message_input_item(text))
                for tool_call in tool_calls:
                    if not isinstance(tool_call, dict):
                        continue
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": str(tool_call.get("id") or ""),
                            "name": str(tool_call.get("name") or ""),
                            "arguments": json.dumps(
                                tool_call.get("args") or {},
                                separators=(",", ":"),
                            ),
                            **(
                                {"reasoning_content": content["reasoningContent"]}
                                if isinstance(content.get("reasoningContent"), str)
                                else {}
                            ),
                        }
                    )
                continue
            text = _content_text(message.content)
            if text:
                items.append(_assistant_message_input_item(text))
            continue
        text = _content_text(message.content)
        if text:
            items.append(_user_message_input_item(text))
    return items


def _user_message_input_item(text: str) -> dict[str, Any]:
    """Build one Responses user message input item."""

    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": text}],
    }


def _assistant_message_input_item(text: str) -> dict[str, Any]:
    """Build one Responses assistant message replay item."""

    return {
        "type": "message",
        "role": "assistant",
        "content": [
            {
                "type": "output_text",
                "text": text,
                "annotations": [],
            }
        ],
    }


def _dict_content(value: object) -> dict[str, Any]:
    """Return message content as a dictionary when possible."""

    return value if isinstance(value, dict) else {}


def _content_text(value: object) -> str:
    """Read text from stored transcript content."""

    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text
    return json.dumps(value, separators=(",", ":"))
