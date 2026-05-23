# q1: 为什么 DeepSeek adapter 放在 services/api，而不是 runtime 或 route？
# a1: 它是 outbound API anti-corruption layer，只把 DeepSeek/OpenAI-compatible
#     chat-completions 形状翻译成 kodeks 内部事件和 provider contract。
# q2: 为什么这里不用 Responses API 的 previous_response_id？
# a2: DeepSeek chat completions 是 stateless；多轮上下文必须由 runtime/session
#     显式组装 messages，provider 不保存业务 session 状态。

import json
import os
from collections.abc import AsyncIterator
from typing import Any

from openai import AsyncOpenAI

from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatMessage, ChatProviderRequest, ToolDefinition


class DeepSeekChatCompletionsProvider:
    """Translate DeepSeek chat-completions streams into kodeks runtime events."""

    def __init__(self, client: object | None = None) -> None:
        self._client = client
        self._tool_payload_cache: dict[str, dict[str, object]] = {}

    async def stream_response(
        self,
        request: ChatProviderRequest,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Stream one DeepSeek chat-completions turn as kodeks runtime events."""

        api_key = (
            os.getenv("LLM_API_KEY")
            or os.getenv("DEEPSEEK_API_KEY")
            or os.getenv("OPENAI_API_KEY")
        )
        base_url = (
            os.getenv("LLM_BASE_URL")
            or os.getenv("DEEPSEEK_BASE_URL")
            or "https://api.deepseek.com"
        )
        model = os.getenv("LLM_MODEL", "deepseek-v4-flash")

        if not api_key and self._client is None:
            yield ChatStreamEvent(
                type="error",
                message="LLM_API_KEY or DEEPSEEK_API_KEY is not set",
            )
            return

        try:
            client = self._client
            if client is None:
                client = AsyncOpenAI(api_key=api_key, base_url=base_url)
                self._client = client

            messages = self._messages_payload(request)
            kwargs = {
                "model": model,
                "messages": messages,
                "stream": True,
            }

            if request.tools:
                kwargs["tools"] = [self._tool_payload(tool) for tool in request.tools]

            stream = await client.chat.completions.create(**kwargs)
            event_count = 0
            response_id: str | None = None
            finish_reason: str | None = None
            tool_call_chunks: dict[int, dict[str, str]] = {}

            async for chunk in stream:
                event_count += 1
                response_id = getattr(chunk, "id", None) or response_id
                choice = self._first_choice(chunk)
                if choice is None:
                    continue

                finish_reason = getattr(choice, "finish_reason", None) or finish_reason
                delta = getattr(choice, "delta", None)
                if delta is None:
                    continue

                content = getattr(delta, "content", None)
                if content:
                    yield ChatStreamEvent(type="text_delta", delta=content)

                self._accumulate_tool_calls(
                    tool_call_chunks,
                    getattr(delta, "tool_calls", None),
                )

            if event_count == 0:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without events",
                )
                return

            if finish_reason is None:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without a terminal event",
                )
                return

            if finish_reason == "stop":
                yield ChatStreamEvent(
                    type="response_completed",
                    response_id=response_id or "chatcmpl_unknown",
                )
                return

            if finish_reason == "tool_calls":
                for tool_call in self._tool_call_events(tool_call_chunks):
                    yield tool_call
                yield ChatStreamEvent(
                    type="response_completed",
                    response_id=response_id or "chatcmpl_tool_calls",
                )
                return

            yield ChatStreamEvent(
                type="error",
                message=f"LLM response did not finish cleanly: {finish_reason}",
            )

        except Exception:
            yield ChatStreamEvent(
                type="error",
                message="LLM provider request failed",
            )

    def _messages_payload(
        self,
        request: ChatProviderRequest,
    ) -> list[dict[str, object]]:
        """Build OpenAI-compatible chat messages from a provider-neutral request."""

        messages = request.messages or [ChatMessage(role="user", content=request.user_input)]
        payload = [self._message_payload(message) for message in messages]

        for tool_output in request.tool_outputs:
            payload.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_output.tool_call_id,
                    "content": tool_output.output,
                }
            )

        return payload

    def _message_payload(self, message: ChatMessage) -> dict[str, object]:
        """Convert one neutral chat message into chat-completions JSON."""

        payload: dict[str, object] = {"role": message.role}
        if message.content is not None or message.role == "assistant":
            payload["content"] = message.content
        if message.tool_call_id is not None:
            payload["tool_call_id"] = message.tool_call_id
        if message.tool_calls is not None:
            payload["tool_calls"] = message.tool_calls
        return payload

    def _tool_payload(self, tool: ToolDefinition) -> dict[str, object]:
        """Build one DeepSeek chat-completions function tool payload."""

        cache_key = self._tool_payload_cache_key(tool)
        cached_payload = self._tool_payload_cache.get(cache_key)
        if cached_payload is not None:
            return cached_payload

        parameters = tool.parameters
        function: dict[str, object] = {
            "name": tool.name,
            "description": tool.description,
            "parameters": parameters,
        }
        if tool.strict and self._strict_tools_enabled():
            function["parameters"] = self._strict_json_schema(parameters)
            function["strict"] = True

        payload: dict[str, object] = {
            "type": "function",
            "function": function,
        }
        self._tool_payload_cache[cache_key] = payload
        return payload

    def _tool_payload_cache_key(self, tool: ToolDefinition) -> str:
        """Return a stable cache key for a provider-neutral tool definition."""

        return json.dumps(
            {
                "tool": tool.model_dump(mode="json"),
                "strict_tools": self._strict_tools_enabled(),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def _strict_tools_enabled(self) -> bool:
        """Return whether DeepSeek beta strict function calling is enabled."""

        return os.getenv("LLM_STRICT_TOOLS", "").lower() in {"1", "true", "yes"}

    def _strict_json_schema(self, schema: dict[str, Any]) -> dict[str, Any]:
        """Normalize object schemas for strict function calling."""

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

    def _first_choice(self, chunk: object) -> object | None:
        """Return the first streamed choice from an SDK chunk."""

        choices = getattr(chunk, "choices", None)
        if not choices:
            return None
        return choices[0]

    def _accumulate_tool_calls(
        self,
        tool_call_chunks: dict[int, dict[str, str]],
        streamed_tool_calls: object,
    ) -> None:
        """Accumulate streamed tool-call deltas by their provider index."""

        if not streamed_tool_calls:
            return

        for streamed_tool_call in streamed_tool_calls:
            index = int(getattr(streamed_tool_call, "index", 0) or 0)
            current = tool_call_chunks.setdefault(
                index,
                {"id": "", "name": "", "arguments": ""},
            )
            tool_call_id = getattr(streamed_tool_call, "id", None)
            if tool_call_id:
                current["id"] = tool_call_id

            function = getattr(streamed_tool_call, "function", None)
            if function is None:
                continue

            name = getattr(function, "name", None)
            if name:
                current["name"] = name

            arguments = getattr(function, "arguments", None)
            if arguments:
                current["arguments"] += arguments

    def _tool_call_events(
        self,
        tool_call_chunks: dict[int, dict[str, str]],
    ) -> list[ChatStreamEvent]:
        """Convert accumulated tool-call chunks into runtime events."""

        events: list[ChatStreamEvent] = []
        for index in sorted(tool_call_chunks):
            tool_call = tool_call_chunks[index]
            if not tool_call["id"] or not tool_call["name"]:
                continue
            events.append(
                ChatStreamEvent(
                    type="tool_call",
                    tool_call_id=tool_call["id"],
                    tool_name=tool_call["name"],
                    tool_arguments=self._tool_arguments(tool_call["arguments"]),
                )
            )
        return events

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
