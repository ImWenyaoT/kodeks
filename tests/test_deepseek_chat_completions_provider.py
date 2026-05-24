import unittest
from types import SimpleNamespace
from unittest.mock import patch

import kodeks.services.api.deepseek_chat_completions as deepseek_module
from kodeks.runtime.provider import ChatMessage, ChatProviderRequest, ToolDefinition, ToolOutput


class FakeStream:
    """Async iterator that yields fake chat completion chunks."""

    def __init__(self, events: list[object]) -> None:
        self._events = events

    def __aiter__(self) -> "FakeStream":
        """Return this fake stream as its own async iterator."""

        self._iterator = iter(self._events)
        return self

    async def __anext__(self) -> object:
        """Yield the next fake chunk."""

        try:
            return next(self._iterator)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeChatCompletions:
    """Fake chat.completions surface that records create kwargs."""

    def __init__(self, events: list[object], calls: list[dict[str, object]]) -> None:
        self._events = events
        self._calls = calls

    async def create(self, **kwargs: object) -> FakeStream:
        """Record create kwargs and return the configured fake stream."""

        self._calls.append(kwargs)
        return FakeStream(self._events)


class FakeOpenAI:
    """Minimal AsyncOpenAI replacement for DeepSeek provider unit tests."""

    events: list[object] = []
    calls: list[dict[str, object]] = []
    constructor_kwargs: list[dict[str, object]] = []

    def __init__(self, **kwargs: object) -> None:
        self.constructor_kwargs.append(kwargs)
        self.chat = SimpleNamespace(
            completions=FakeChatCompletions(self.events, self.calls)
        )


def chunk(
    *,
    chunk_id: str = "chatcmpl_1",
    content: str | None = None,
    finish_reason: str | None = None,
    tool_calls: list[object] | None = None,
) -> object:
    """Build one fake OpenAI-compatible chat completion stream chunk."""

    delta = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(delta=delta, finish_reason=finish_reason)
    return SimpleNamespace(id=chunk_id, choices=[choice])


async def collect_provider_events(request: ChatProviderRequest):
    """Collect all events emitted by the DeepSeek chat completions provider."""

    provider = deepseek_module.DeepSeekChatCompletionsProvider()
    return [event async for event in provider.stream_response(request)]


class DeepSeekChatCompletionsProviderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        """Reset fake OpenAI-compatible client state before each test."""

        FakeOpenAI.events = []
        FakeOpenAI.calls = []
        FakeOpenAI.constructor_kwargs = []

    async def test_missing_key_emits_error_event(self) -> None:
        """Verify missing DeepSeek credentials return an SSE-friendly error event."""

        with patch.dict(
            "os.environ",
            {"LLM_API_KEY": "", "DEEPSEEK_API_KEY": "", "OPENAI_API_KEY": ""},
            clear=False,
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual(events[0].type, "error")
        self.assertEqual(events[0].message, "LLM_API_KEY or DEEPSEEK_API_KEY is not set")

    async def test_stream_translates_text_and_completion_events(self) -> None:
        """Verify normal DeepSeek chat stream chunks become kodeks stream events."""

        FakeOpenAI.events = [
            chunk(content="hel"),
            chunk(content="lo", finish_reason="stop"),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(deepseek_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(
                ChatProviderRequest(
                    user_input="hello",
                    messages=[
                        ChatMessage(role="user", content="previous"),
                        ChatMessage(role="assistant", content="answer"),
                        ChatMessage(role="user", content="hello"),
                    ],
                )
            )

        self.assertEqual(
            [event.type for event in events],
            ["text_delta", "text_delta", "response_completed"],
        )
        self.assertEqual([event.delta for event in events[:2]], ["hel", "lo"])
        self.assertEqual(events[-1].response_id, "chatcmpl_1")
        self.assertEqual(
            FakeOpenAI.calls[0],
            {
                "model": "deepseek-v4-flash",
                "messages": [
                    {"role": "user", "content": "previous"},
                    {"role": "assistant", "content": "answer"},
                    {"role": "user", "content": "hello"},
                ],
                "stream": True,
            },
        )
        self.assertEqual(
            FakeOpenAI.constructor_kwargs[0],
            {"api_key": "test-key", "base_url": "https://api.deepseek.com"},
        )

    async def test_tool_definitions_are_forwarded_to_chat_completions_api(self) -> None:
        """Verify provider-neutral tools become DeepSeek chat-completions functions."""

        FakeOpenAI.events = [chunk(finish_reason="stop")]
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
            patch.object(deepseek_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(ChatProviderRequest(user_input="read README", tools=[tool]))

        self.assertEqual(
            FakeOpenAI.calls[0]["tools"],
            [
                {
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "description": "Read a workspace file.",
                        "parameters": {
                            "type": "object",
                            "properties": {"path": {"type": "string"}},
                            "required": ["path"],
                        },
                    },
                }
            ],
        )
        self.assertNotIn("strict", FakeOpenAI.calls[0]["tools"][0]["function"])

    async def test_streamed_tool_call_chunks_become_tool_call_event(self) -> None:
        """Verify DeepSeek streamed tool call deltas are accumulated before execution."""

        FakeOpenAI.events = [
            chunk(
                tool_calls=[
                    SimpleNamespace(
                        index=0,
                        id="call_1",
                        type="function",
                        function=SimpleNamespace(name="read_file", arguments='{"path"'),
                    )
                ]
            ),
            chunk(
                finish_reason="tool_calls",
                tool_calls=[
                    SimpleNamespace(
                        index=0,
                        id=None,
                        type=None,
                        function=SimpleNamespace(name=None, arguments=': "README.md"}'),
                    )
                ],
            ),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(deepseek_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="read README"))

        self.assertEqual([event.type for event in events], ["tool_call", "response_completed"])
        self.assertEqual(events[0].tool_call_id, "call_1")
        self.assertEqual(events[0].tool_name, "read_file")
        self.assertEqual(events[0].tool_arguments, {"path": "README.md"})

    async def test_stream_without_terminal_finish_reason_emits_error(self) -> None:
        """Verify truncated chat streams do not silently become completed turns."""

        FakeOpenAI.events = [
            chunk(content="partial"),
        ]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(deepseek_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_provider_events(ChatProviderRequest(user_input="hello"))

        self.assertEqual([event.type for event in events], ["text_delta", "error"])
        self.assertEqual(events[-1].message, "LLM stream ended without a terminal event")

    async def test_tool_outputs_are_forwarded_as_chat_messages(self) -> None:
        """Verify local tool results are translated into DeepSeek tool messages."""

        FakeOpenAI.events = [chunk(finish_reason="stop")]

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(deepseek_module, "AsyncOpenAI", FakeOpenAI),
        ):
            await collect_provider_events(
                ChatProviderRequest(
                    user_input="",
                    messages=[
                        ChatMessage(role="user", content="read README"),
                        ChatMessage(
                            role="assistant",
                            content=None,
                            tool_calls=[
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": '{"path": "README.md"}',
                                    },
                                }
                            ],
                        ),
                    ],
                    tool_outputs=[ToolOutput(tool_call_id="call_1", output="# kodeks")],
                )
            )

        self.assertEqual(
            FakeOpenAI.calls[0]["messages"],
            [
                {"role": "user", "content": "read README"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": '{"path": "README.md"}',
                            },
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "# kodeks"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
