import unittest
from types import SimpleNamespace
from unittest.mock import patch

import kodeks.services.api.openai_responses as openai_responses_module
from kodeks.runtime.provider import ChatProviderRequest, ToolDefinition, ToolOutput


class FakeStream:
    """Async iterator that yields fake OpenAI streaming events."""

    def __init__(self, events: list[object]) -> None:
        self._events = events

    def __aiter__(self) -> "FakeStream":
        """Return this fake stream as its own async iterator."""

        self._iterator = iter(self._events)
        return self

    async def __anext__(self) -> object:
        """Yield the next fake event."""

        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeResponses:
    """Fake Responses API surface that records create kwargs."""

    def __init__(self, events: list[object], calls: list[dict[str, object]]) -> None:
        self._events = events
        self._calls = calls

    async def create(self, **kwargs: object) -> FakeStream:
        """Record create kwargs and return the configured fake stream."""

        self._calls.append(kwargs)
        return FakeStream(self._events)


class FakeOpenAI:
    """Minimal AsyncOpenAI replacement for provider-level unit tests."""

    events: list[object] = []
    calls: list[dict[str, object]] = []
    constructor_kwargs: list[dict[str, object]] = []

    def __init__(self, **kwargs: object) -> None:
        self.constructor_kwargs.append(kwargs)
        self.responses = FakeResponses(self.events, self.calls)


async def collect_provider_events(request: ChatProviderRequest):
    """Collect all events emitted by the OpenAI Responses provider."""

    provider = openai_responses_module.OpenAIResponsesProvider()
    return [event async for event in provider.stream_response(request)]


class OpenAIResponsesProviderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        """Reset fake OpenAI state before each test."""

        FakeOpenAI.events = []
        FakeOpenAI.calls = []
        FakeOpenAI.constructor_kwargs = []

    async def test_missing_key_emits_error_event(self) -> None:
        """Verify missing credentials return an SSE-friendly error event."""

        with patch.dict("os.environ", {"LLM_API_KEY": "", "OPENAI_API_KEY": ""}, clear=False):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual(events[0].type, "error")
        self.assertEqual(events[0].message, "LLM_API_KEY or OPENAI_API_KEY is not set")

    async def test_stream_translates_text_and_completion_events(self) -> None:
        """Verify normal Responses stream events become kodeks stream events."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.output_text.delta", delta="hel"),
            SimpleNamespace(type="response.output_text.delta", delta="lo"),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_123")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(
                ChatProviderRequest(
                    user_input="hello",
                    previous_response_id="resp_prev",
                )
            )

        self.assertEqual([event.type for event in events], ["text_delta", "text_delta", "response_completed"])
        self.assertEqual([event.delta for event in events[:2]], ["hel", "lo"])
        self.assertEqual(events[-1].response_id, "resp_123")
        self.assertEqual(
            FakeOpenAI.calls[0],
            {
                "model": "gpt-5.4-mini",
                "input": "hello",
                "stream": True,
                "previous_response_id": "resp_prev",
            },
        )
        self.assertNotIn("timeout", FakeOpenAI.constructor_kwargs[0])

    async def test_provider_reuses_configured_client(self) -> None:
        """Verify provider construction can reuse one OpenAI client across turns."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_1")),
        ]
        fake_client = FakeOpenAI(api_key="test-key")
        provider = openai_responses_module.OpenAIResponsesProvider(client=fake_client)

        [event async for event in provider.stream_response(ChatProviderRequest(user_input="one"))]
        [event async for event in provider.stream_response(ChatProviderRequest(user_input="two"))]

        self.assertEqual(len(FakeOpenAI.constructor_kwargs), 1)
        self.assertEqual(len(FakeOpenAI.calls), 2)

    async def test_provider_exceptions_return_safe_error_message(self) -> None:
        """Verify unexpected provider exceptions do not leak raw exception details."""

        class BrokenResponses:
            async def create(self, **kwargs: object) -> object:
                """Raise a raw error that should not be exposed to clients."""

                raise RuntimeError("secret-token-123")

        fake_client = SimpleNamespace(responses=BrokenResponses())
        provider = openai_responses_module.OpenAIResponsesProvider(client=fake_client)

        events = [
            event async for event in provider.stream_response(ChatProviderRequest(user_input="hello"))
        ]

        self.assertEqual(events[0].type, "error")
        self.assertEqual(events[0].message, "LLM provider request failed")

    async def test_tool_definitions_are_forwarded_to_responses_api(self) -> None:
        """Verify provider-neutral tool definitions are translated for OpenAI."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]
        tool = ToolDefinition(
            name="read_file",
            description="Read a workspace file.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        )

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(ChatProviderRequest(user_input="read README", tools=[tool]))

        self.assertEqual(
            FakeOpenAI.calls[0]["tools"],
            [
                {
                    "type": "function",
                    "name": "read_file",
                    "description": "Read a workspace file.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                        "additionalProperties": False,
                    },
                    "strict": True,
                }
            ],
        )

    async def test_strict_tool_schema_is_normalized_without_mutating_source(self) -> None:
        """Verify strict tool schemas include required object constraints for OpenAI."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]
        original_parameters = {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "options": {
                    "type": "object",
                    "properties": {"encoding": {"type": "string"}},
                },
            },
        }
        tool = ToolDefinition(
            name="read_file",
            description="Read a workspace file.",
            parameters=original_parameters,
        )

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(ChatProviderRequest(user_input="read README", tools=[tool]))

        sent_parameters = FakeOpenAI.calls[0]["tools"][0]["parameters"]
        self.assertEqual(sent_parameters["required"], ["path", "options"])
        self.assertFalse(sent_parameters["additionalProperties"])
        self.assertEqual(sent_parameters["properties"]["options"]["required"], ["encoding"])
        self.assertFalse(sent_parameters["properties"]["options"]["additionalProperties"])
        self.assertNotIn("required", original_parameters)

    async def test_strict_tool_payload_is_cached_across_turns(self) -> None:
        """Verify repeated tool definitions are normalized once per provider instance."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]
        fake_client = FakeOpenAI(api_key="test-key")
        provider = openai_responses_module.OpenAIResponsesProvider(client=fake_client)
        tool = ToolDefinition(
            name="read_file",
            description="Read a workspace file.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
            },
        )

        with patch.object(
            provider,
            "_strict_json_schema",
            wraps=provider._strict_json_schema,
        ) as strict_json_schema:
            [
                event
                async for event in provider.stream_response(
                    ChatProviderRequest(user_input="read one", tools=[tool])
                )
            ]
            [
                event
                async for event in provider.stream_response(
                    ChatProviderRequest(user_input="read two", tools=[tool])
                )
            ]

        self.assertEqual(strict_json_schema.call_count, 2)
        self.assertEqual(len(FakeOpenAI.calls), 2)

    async def test_non_strict_tool_schema_is_forwarded_unchanged(self) -> None:
        """Verify callers can opt out of strict schema normalization."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]
        parameters = {
            "type": "object",
            "properties": {"path": {"type": "string"}},
        }
        tool = ToolDefinition(
            name="read_file",
            description="Read a workspace file.",
            parameters=parameters,
            strict=False,
        )

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(ChatProviderRequest(user_input="read README", tools=[tool]))

        self.assertEqual(FakeOpenAI.calls[0]["tools"][0]["parameters"], parameters)
        self.assertFalse(FakeOpenAI.calls[0]["tools"][0]["strict"])

    async def test_tool_outputs_are_forwarded_as_function_call_outputs(self) -> None:
        """Verify local tool results are translated into Responses input items."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_final")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(
                ChatProviderRequest(
                    user_input="",
                    previous_response_id="resp_tool",
                    tool_outputs=[ToolOutput(tool_call_id="call_1", output="# kodeks")],
                )
            )

        self.assertEqual(
            FakeOpenAI.calls[0]["input"],
            [
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "# kodeks",
                }
            ],
        )
        self.assertEqual(FakeOpenAI.calls[0]["previous_response_id"], "resp_tool")

    async def test_function_call_output_item_becomes_tool_call_event(self) -> None:
        """Verify streamed function_call items become structured runtime tool_call events."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(
                    type="function_call",
                    call_id="call_1",
                    name="read_file",
                    arguments='{"path": "README.md"}',
                ),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="read README"))

        self.assertEqual(events[0].type, "tool_call")
        self.assertEqual(events[0].tool_call_id, "call_1")
        self.assertEqual(events[0].tool_name, "read_file")
        self.assertEqual(events[0].tool_arguments, {"path": "README.md"})
        self.assertEqual(events[1].type, "response_completed")

    async def test_function_call_arguments_fall_back_for_invalid_json(self) -> None:
        """Verify malformed function-call arguments are preserved for diagnostics."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(
                    type="function_call",
                    call_id="call_1",
                    name="read_file",
                    arguments="{bad json",
                ),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="read README"))

        self.assertEqual(events[0].tool_arguments, {"_raw": "{bad json"})

    async def test_function_call_arguments_wrap_non_object_json(self) -> None:
        """Verify scalar JSON function-call arguments stay structurally valid."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(
                    type="function_call",
                    call_id="call_1",
                    name="read_file",
                    arguments="42",
                ),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_tool")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="read README"))

        self.assertEqual(events[0].tool_arguments, {"_value": 42})

    async def test_non_function_output_items_are_ignored(self) -> None:
        """Verify unrelated output items do not become tool_call events."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(type="message", content=[]),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_done")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual([event.type for event in events], ["response_completed"])

    async def test_function_call_missing_required_fields_is_ignored(self) -> None:
        """Verify incomplete provider tool-call items cannot violate event validation."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.output_item.done",
                item=SimpleNamespace(type="function_call", call_id="", name="read_file"),
            ),
            SimpleNamespace(type="response.completed", response=SimpleNamespace(id="resp_done")),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual([event.type for event in events], ["response_completed"])

    async def test_empty_stream_emits_error_event(self) -> None:
        """Verify a provider stream with no events is surfaced as an error."""

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual(events[0].type, "error")
        self.assertEqual(events[0].message, "LLM stream ended without events")

    async def test_incomplete_stream_emits_error_event(self) -> None:
        """Verify response.incomplete is a terminal error in our event contract."""

        FakeOpenAI.events = [
            SimpleNamespace(
                type="response.incomplete",
                response=SimpleNamespace(
                    id="resp_bad",
                    incomplete_details={"reason": "max_output_tokens"},
                ),
            )
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual(events[0].type, "error")
        self.assertIn("LLM response incomplete", events[0].message)

    async def test_stream_without_terminal_event_emits_error_event(self) -> None:
        """Verify truncated streams do not silently end after non-terminal events."""

        FakeOpenAI.events = [
            SimpleNamespace(type="response.created"),
            SimpleNamespace(type="response.output_text.delta", delta="partial"),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual([event.type for event in events], ["text_delta", "error"])
        self.assertEqual(events[-1].message, "LLM stream ended without a terminal event")


if __name__ == "__main__":
    unittest.main()
