"""OpenAI Responses payload and stream adapters for Kodeks."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable, Mapping
from typing import Any

from ..tools.schemas import default_tool_definitions


def build_openai_responses_payload(
    body: Mapping[str, Any], model_options: Mapping[str, Any]
) -> dict[str, Any]:
    """Build the direct OpenAI Responses create payload for one chat turn."""

    reasoning_effort = str(model_options.get("reasoningEffort") or "medium")
    input_value = body.get("input")
    payload: dict[str, Any] = {
        "model": str(model_options["model"]),
        "input": (
            input_value if isinstance(input_value, list) else str(input_value or "")
        ),
        "instructions": str(body.get("instructions") or ""),
        "tools": [
            *_openai_function_tools(
                default_tool_definitions(body.get("mode") == "plan"),
                strict=model_options.get("strictTools") is True,
            ),
            *_openai_hosted_tools(model_options.get("hostedTools")),
        ],
        "store": model_options.get("statefulResponses") is True,
        "reasoning": {"effort": reasoning_effort},
        "stream": True,
    }
    previous_response_id = body.get("previous_response_id")
    if isinstance(previous_response_id, str) and previous_response_id:
        payload["previous_response_id"] = previous_response_id
    return payload


async def normalize_responses_event_stream(
    stream: AsyncIterator[object] | Iterable[object],
) -> AsyncIterator[dict[str, Any]]:
    """Normalize OpenAI SDK Responses stream event objects into dictionaries."""

    async for event in _aiter_objects(stream):
        normalized = _event_to_dict(event)
        if normalized is not None:
            yield normalized


async def _aiter_objects(
    stream: AsyncIterator[object] | Iterable[object],
) -> AsyncIterator[object]:
    """Yield sync or async stream items through one async interface."""

    if isinstance(stream, Iterable):
        for item in stream:
            yield item
        return
    async for item in stream:
        yield item


def _event_to_dict(event: object) -> dict[str, Any] | None:
    """Convert SDK event objects and raw dictionaries into plain dictionaries."""

    if isinstance(event, dict):
        return event
    if hasattr(event, "model_dump"):
        dumped = event.model_dump(by_alias=True, exclude_none=True)
        return dumped if isinstance(dumped, dict) else None
    if hasattr(event, "dict"):
        dumped = event.dict()
        return dumped if isinstance(dumped, dict) else None
    return None


def _openai_function_tools(
    definitions: list[dict[str, Any]], strict: bool
) -> list[dict[str, Any]]:
    """Map local tool definitions into OpenAI Responses function tools."""

    return [
        {
            "type": "function",
            "name": definition["name"],
            "description": definition.get("description", ""),
            "parameters": _strict_tool_parameters(definition["parameters"])
            if strict
            else definition["parameters"],
            "strict": strict,
        }
        for definition in definitions
    ]


def _openai_hosted_tools(value: object) -> list[dict[str, str]]:
    """Return the supported OpenAI hosted tools for direct Responses calls."""

    if not isinstance(value, list):
        return []
    return [
        {"type": item}
        for item in value
        if isinstance(item, str) and item == "web_search_preview"
    ]


def _strict_tool_parameters(parameters: object) -> dict[str, Any]:
    """Normalize a JSON schema for OpenAI strict function tool mode."""

    schema = dict(parameters) if isinstance(parameters, dict) else {}
    properties = schema.get("properties")
    normalized_properties = (
        {
            name: _strict_property_schema(value)
            for name, value in properties.items()
            if isinstance(name, str)
        }
        if isinstance(properties, dict)
        else {}
    )
    return {
        **schema,
        "type": "object",
        "properties": normalized_properties,
        "required": list(normalized_properties.keys()),
        "additionalProperties": False,
    }


def _strict_property_schema(schema: object) -> dict[str, Any]:
    """Recursively normalize nested object and array schema values."""

    if not isinstance(schema, dict):
        return {}
    result = dict(schema)
    nested_properties = result.get("properties")
    if isinstance(nested_properties, dict):
        normalized = {
            name: _strict_property_schema(value)
            for name, value in nested_properties.items()
            if isinstance(name, str)
        }
        result["properties"] = normalized
        result["required"] = list(normalized.keys())
        result["additionalProperties"] = False
    nested_items = result.get("items")
    if isinstance(nested_items, dict):
        result["items"] = _strict_property_schema(nested_items)
    return result
