"""MoonBridge protocol adapters for Python runtime parity."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterable, Mapping
from typing import Any

import httpx2

from .config import read_chat_completions_base_url


def to_deepseek_chat_request(
    request: Mapping[str, Any], model: str | None = None
) -> dict[str, Any]:
    """Convert a Responses-like request into a Chat Completions request."""

    core = to_core_request(request)
    return {
        "model": model or str(core.get("model") or "bridge"),
        "messages": [
            _to_deepseek_chat_message(message) for message in core["messages"]
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get(
                        "parameters", {"type": "object", "properties": {}}
                    ),
                },
            }
            for tool in core["tools"]
        ],
        **_to_deepseek_thinking_options(str(core.get("reasoningEffort") or "high")),
        "stream": True,
    }


def to_core_request(request: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize the subset of Responses requests MoonBridge currently supports."""

    messages: list[dict[str, Any]] = []
    instructions = request.get("instructions")
    if isinstance(instructions, str) and instructions:
        messages.append({"role": "system", "content": instructions})
    raw_input = request.get("input", [])
    if isinstance(raw_input, str):
        messages.append({"role": "user", "content": raw_input})
    elif isinstance(raw_input, list):
        for item in raw_input:
            mapped = _input_item_to_message(item)
            if mapped is not None:
                messages.append(mapped)
    tools = [
        tool
        for tool in request.get("tools", [])
        if isinstance(tool, dict) and tool.get("type") == "function"
    ]
    reasoning = request.get("reasoning")
    effort = reasoning.get("effort") if isinstance(reasoning, dict) else None
    return {
        "model": request.get("model") or "bridge",
        "messages": messages,
        "tools": tools,
        "reasoningEffort": effort or "high",
    }


async def fetch_chat_completions_stream(
    payload: Mapping[str, Any],
    api_key: str,
    env: Mapping[str, str | None],
) -> AsyncIterator[dict[str, Any]]:
    """Call an upstream Chat Completions endpoint and yield parsed SSE chunks."""

    base_url = read_chat_completions_base_url(env).rstrip("/")
    async with httpx2.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "kodeks-python-moonbridge/0.1",
            },
            json=payload,
        ) as response:
            if response.status_code >= 400:
                yield {
                    "error": {
                        "message": f"DeepSeek request failed: {response.status_code} {response.reason_phrase}"
                    }
                }
                return
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line.removeprefix("data: ").strip()
                if data == "[DONE]":
                    return
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk, dict):
                    yield chunk


async def from_deepseek_stream(
    stream: AsyncIterator[dict[str, Any]] | Iterable[dict[str, Any]],
    response_id: str = "resp_bridge",
    model: str = "bridge",
) -> AsyncIterator[dict[str, Any]]:
    """Map Chat Completions stream chunks into Responses stream events."""

    pending_tool_calls: dict[int, dict[str, str]] = {}
    completed_output_items: list[dict[str, Any]] = []
    output_index = 0
    message_text = ""
    reasoning_content = ""
    async for chunk in _aiter(stream):
        error = chunk.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            yield _response_failed_event(response_id, model, error["message"])
            continue
        response_id = str(chunk.get("id") or response_id)
        choice = _first_choice(chunk)
        delta = choice.get("delta") if choice else {}
        if not isinstance(delta, dict):
            delta = {}
        reasoning_delta = delta.get("reasoning_content")
        if isinstance(reasoning_delta, str) and reasoning_delta:
            reasoning_content += reasoning_delta
        content = delta.get("content")
        if isinstance(content, str) and content:
            message_text += content
            yield {
                "type": "response.output_text.delta",
                "delta": content,
                "output_index": output_index,
                "content_index": 0,
                "item_id": f"msg_{response_id}",
            }
        for tool_call in (
            delta.get("tool_calls", [])
            if isinstance(delta.get("tool_calls"), list)
            else []
        ):
            _merge_tool_call_chunk(pending_tool_calls, tool_call)
        finish_reason = choice.get("finish_reason") if choice else None
        if finish_reason == "tool_calls":
            for tool_call in pending_tool_calls.values():
                item: dict[str, Any] = {
                    "id": f"fc_{tool_call['id']}",
                    "type": "function_call",
                    "call_id": tool_call["id"],
                    "name": tool_call["name"],
                    "arguments": tool_call["argumentsText"],
                    "status": "completed",
                }
                if reasoning_content:
                    item["reasoning_content"] = reasoning_content
                completed_output_items.append(item)
                yield {
                    "type": "response.output_item.done",
                    "output_index": output_index,
                    "item": item,
                }
                output_index += 1
            pending_tool_calls.clear()
            yield _response_completed_event(
                response_id, model, message_text, completed_output_items
            )
            message_text = ""
            reasoning_content = ""
            completed_output_items = []
        elif finish_reason is not None:
            yield _response_completed_event(
                response_id, model, message_text, completed_output_items
            )
            message_text = ""
            reasoning_content = ""
            completed_output_items = []


def _input_item_to_message(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    item_type = item.get("type")
    if item_type == "function_call_output":
        return {
            "role": "tool",
            "content": str(item.get("output") or ""),
            "toolCallId": str(item.get("call_id") or ""),
        }
    if item_type == "function_call":
        return {
            "role": "assistant",
            "content": "",
            "toolCalls": [
                {
                    "id": str(item.get("call_id") or ""),
                    "name": str(item.get("name") or ""),
                    "argumentsText": str(item.get("arguments") or "{}"),
                }
            ],
            **(
                {"reasoningContent": item["reasoning_content"]}
                if isinstance(item.get("reasoning_content"), str)
                else {}
            ),
        }
    role = item.get("role")
    content = item.get("content")
    if role in {"user", "assistant", "system"}:
        return {"role": role, "content": _text_from_content(content)}
    return None


def _to_deepseek_chat_message(message: Mapping[str, Any]) -> dict[str, Any]:
    role = message.get("role")
    if role == "tool":
        return {
            "role": "tool",
            "content": str(message.get("content") or ""),
            "tool_call_id": str(message.get("toolCallId") or ""),
        }
    if role == "assistant":
        raw_tool_calls = message.get("toolCalls")
        tool_calls: list[Any] = raw_tool_calls if isinstance(raw_tool_calls, list) else []
        has_tool_calls = len(tool_calls) > 0
        content = message.get("content")
        result: dict[str, Any] = {
            "role": "assistant",
            "content": str(content) if isinstance(content, str) and content else None,
        }
        if isinstance(message.get("reasoningContent"), str):
            result["reasoning_content"] = message["reasoningContent"]
        if has_tool_calls:
            result["content"] = str(content) if isinstance(content, str) else ""
            result["tool_calls"] = [
                {
                    "id": str(tool_call.get("id") or ""),
                    "type": "function",
                    "function": {
                        "name": str(tool_call.get("name") or ""),
                        "arguments": str(tool_call.get("argumentsText") or "{}"),
                    },
                }
                for tool_call in tool_calls
                if isinstance(tool_call, dict)
            ]
        return result
    return {"role": role, "content": str(message.get("content") or "")}


def _to_deepseek_thinking_options(reasoning_effort: str) -> dict[str, Any]:
    if reasoning_effort == "none":
        return {"thinking": {"type": "disabled"}}
    return {
        "thinking": {"type": "enabled"},
        "reasoning_effort": "max" if reasoning_effort == "xhigh" else "high",
    }


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                for key in ("text", "output_text", "input_text"):
                    text = item.get(key)
                    if isinstance(text, str):
                        parts.append(text)
                        break
        return "".join(parts)
    return ""


def _first_choice(chunk: Mapping[str, Any]) -> dict[str, Any]:
    choices = chunk.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        return choices[0]
    return {}


def _merge_tool_call_chunk(pending: dict[int, dict[str, str]], tool_call: Any) -> None:
    if not isinstance(tool_call, dict):
        return
    index = int(tool_call.get("index") or 0)
    current = pending.setdefault(
        index, {"id": f"call_{index}", "name": "", "argumentsText": ""}
    )
    if isinstance(tool_call.get("id"), str):
        current["id"] = tool_call["id"]
    function = tool_call.get("function")
    if isinstance(function, dict):
        if isinstance(function.get("name"), str):
            current["name"] = function["name"]
        if isinstance(function.get("arguments"), str):
            current["argumentsText"] += function["arguments"]


def _response_completed_event(
    response_id: str,
    model: str,
    message_text: str,
    completed_output_items: list[dict[str, Any]],
) -> dict[str, Any]:
    output: list[dict[str, Any]] = []
    if message_text:
        output.append(
            {
                "id": f"msg_{response_id}",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": message_text, "annotations": []}
                ],
            }
        )
    output.extend(completed_output_items)
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "model": model,
            "status": "completed",
            "output": output,
        },
    }


def _response_failed_event(
    response_id: str, model: str, message: str
) -> dict[str, Any]:
    return {
        "type": "response.failed",
        "response": {
            "id": response_id,
            "model": model,
            "status": "failed",
            "error": {"message": message},
            "output": [
                {
                    "id": f"msg_{response_id}_failed",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": f"MoonBridge upstream failed: {message}",
                            "annotations": [],
                        }
                    ],
                }
            ],
        },
    }


async def _aiter(
    stream: AsyncIterator[dict[str, Any]] | Iterable[dict[str, Any]],
) -> AsyncIterator[dict[str, Any]]:
    if isinstance(stream, Iterable):
        for item in stream:
            yield item
        return
    async for item in stream:
        yield item
