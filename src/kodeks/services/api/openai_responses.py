# q1: 为什么 OpenAI Responses API 放在 services/api，而不是 runtime 或 api/routes？
# a1: 这里的 api 是 outbound API client，和 Claude Code 的 services/api 类似；它负责调用外部模型服务，不负责 FastAPI 入站路由。
# q2: 面试里怎么解释这层？
# a2: 这是 anti-corruption layer。它把外部 API 形状翻译成项目内部协议，后续换 provider 或接本地模型时，不需要重写 HTTP route 和 agent runtime。

import json
import os
from collections.abc import AsyncIterator
from typing import Any

from openai import AsyncOpenAI

from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatProviderRequest, ToolDefinition


class OpenAIResponsesProvider:
    """Translate OpenAI Responses API streams into kodeks runtime events."""

    async def stream_response(
        self,
        request: ChatProviderRequest,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Stream one Responses API turn as kodeks runtime events."""

        api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("LLM_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        model = os.getenv("LLM_MODEL", "gpt-5.4-mini")

        if not api_key:
            yield ChatStreamEvent(
                type="error",
                message="LLM_API_KEY or OPENAI_API_KEY is not set",
            )
            return

        try:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
            kwargs = {
                "model": model,
                "input": self._input_payload(request),
                "stream": True,
            }

            if request.previous_response_id:
                kwargs["previous_response_id"] = request.previous_response_id

            if request.tools:
                kwargs["tools"] = [self._tool_payload(tool) for tool in request.tools]

            stream = await client.responses.create(**kwargs)
            event_count = 0
            terminal_event_seen = False

            async for event in stream:
                event_count += 1

                if event.type == "response.output_text.delta":
                    yield ChatStreamEvent(
                        type="text_delta",
                        delta=event.delta,
                    )

                elif event.type == "response.completed":
                    terminal_event_seen = True
                    yield ChatStreamEvent(
                        type="response_completed",
                        response_id=event.response.id,
                    )

                elif event.type in {"response.failed", "response.incomplete", "error"}:
                    terminal_event_seen = True
                    yield ChatStreamEvent(
                        type="error",
                        message=self._error_message(event),
                    )

                elif event.type == "response.output_item.done":
                    tool_call_event = self._tool_call_event(event)
                    if tool_call_event is not None:
                        yield tool_call_event

            if event_count == 0:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without events",
                )
            elif not terminal_event_seen:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without a terminal event",
                )

        except Exception as exc:
            yield ChatStreamEvent(
                type="error",
                message=str(exc),
            )

    def _input_payload(self, request: ChatProviderRequest) -> object:
        """Build the Responses API input payload for text or tool-output turns."""

        if not request.tool_outputs:
            return request.user_input

        return [
            {
                "type": "function_call_output",
                "call_id": tool_output.tool_call_id,
                "output": tool_output.output,
            }
            for tool_output in request.tool_outputs
        ]

    def _tool_payload(self, tool: ToolDefinition) -> dict[str, object]:
        """Build one Responses API function tool payload from a neutral tool definition."""

        parameters = tool.parameters
        if tool.strict:
            parameters = self._strict_json_schema(parameters)

        return {
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": parameters,
            "strict": tool.strict,
        }

    def _strict_json_schema(self, schema: dict[str, Any]) -> dict[str, Any]:
        """Normalize object schemas for OpenAI strict function calling."""

        normalized = dict(schema)
        schema_type = normalized.get("type")
        properties = normalized.get("properties")
        is_object_schema = (
            schema_type == "object"
            or (isinstance(schema_type, list) and "object" in schema_type)
            or isinstance(properties, dict)
        )

        if isinstance(properties, dict):
            normalized["properties"] = {
                name: self._strict_json_schema(property_schema)
                if isinstance(property_schema, dict)
                else property_schema
                for name, property_schema in properties.items()
            }

        items = normalized.get("items")
        if isinstance(items, dict):
            normalized["items"] = self._strict_json_schema(items)

        for keyword in ("anyOf", "oneOf", "allOf"):
            variants = normalized.get(keyword)
            if isinstance(variants, list):
                normalized[keyword] = [
                    self._strict_json_schema(variant)
                    if isinstance(variant, dict)
                    else variant
                    for variant in variants
                ]

        if is_object_schema:
            normalized["additionalProperties"] = False
            if isinstance(properties, dict):
                normalized["required"] = list(properties.keys())

        return normalized

    def _tool_call_event(self, event: object) -> ChatStreamEvent | None:
        """Translate a completed Responses function_call output item into a runtime event."""

        item = getattr(event, "item", None)
        if getattr(item, "type", None) != "function_call":
            return None

        tool_call_id = getattr(item, "call_id", None)
        tool_name = getattr(item, "name", None)
        raw_arguments = getattr(item, "arguments", "{}")

        if not tool_call_id or not tool_name:
            return None

        return ChatStreamEvent(
            type="tool_call",
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            tool_arguments=self._tool_arguments(raw_arguments),
        )

    def _tool_arguments(self, raw_arguments: object) -> dict[str, object]:
        """Parse tool arguments from the JSON string returned by the provider."""

        if isinstance(raw_arguments, dict):
            return raw_arguments

        if not isinstance(raw_arguments, str) or not raw_arguments:
            return {}

        try:
            parsed = json.loads(raw_arguments)
        except json.JSONDecodeError:
            return {"_raw": raw_arguments}

        if isinstance(parsed, dict):
            return parsed

        return {"_value": parsed}

    def _error_message(self, event: object) -> str:
        """Extract a useful provider error without exposing SDK event classes."""

        response = getattr(event, "response", None)
        response_id = getattr(response, "id", None)
        incomplete_details = getattr(response, "incomplete_details", None)
        error = getattr(event, "error", None) or getattr(response, "error", None)
        message = getattr(error, "message", None) if error is not None else None

        if message:
            return message
        if incomplete_details:
            return f"LLM response incomplete: {incomplete_details}"
        if response_id:
            return f"LLM response did not complete: {response_id}"
        return "LLM response failed"
