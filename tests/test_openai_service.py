import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import kodeks.api.routes.chat as chat_route_module
import kodeks.services.api.openai_responses as openai_responses_module
from fastapi.testclient import TestClient
from kodeks.api.routes.chat import to_sse
from kodeks.main import app
from kodeks.runtime.chat_runtime import ChatRuntime
from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.session_state import InMemorySessionStateStore, SQLiteSessionStateStore
from kodeks.schemas.chat import ChatStreamRequest


class FakeStream:
    """Async iterator that yields fake OpenAI streaming events."""

    def __init__(self, events: list[object]) -> None:
        self._events = events

    def __aiter__(self) -> "FakeStream":
        self._iterator = iter(self._events)
        return self

    async def __anext__(self) -> object:
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
        self._calls.append(kwargs)
        return FakeStream(self._events)


class FakeOpenAI:
    """Minimal AsyncOpenAI replacement for service-level unit tests."""

    events: list[object] = []
    calls: list[dict[str, object]] = []
    constructor_kwargs: list[dict[str, object]] = []

    def __init__(self, **kwargs: object) -> None:
        self.constructor_kwargs.append(kwargs)
        self.responses = FakeResponses(self.events, self.calls)


class FakeProvider:
    """Provider test double for runtime-level session tests."""

    def __init__(self, events: list[ChatStreamEvent]) -> None:
        self.events = events
        self.calls: list[dict[str, str | None]] = []

    async def stream_response(
        self,
        user_input: str,
        previous_response_id: str | None = None,
    ):
        """Record runtime inputs and yield configured events."""

        self.calls.append(
            {
                "user_input": user_input,
                "previous_response_id": previous_response_id,
            }
        )
        for event in self.events:
            yield event


async def collect_events(request: ChatStreamRequest) -> list[ChatStreamEvent]:
    """Collect all events emitted by the chat runtime for one request."""

    provider = openai_responses_module.OpenAIResponsesProvider()
    runtime = ChatRuntime(provider=provider)
    return [event async for event in runtime.stream_chat(request)]


class OpenAIResponsesProviderTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        """Reset fake OpenAI state before each test."""

        FakeOpenAI.events = []
        FakeOpenAI.calls = []
        FakeOpenAI.constructor_kwargs = []

    async def test_missing_key_emits_error_event(self) -> None:
        """Verify missing credentials return an SSE-friendly error event."""

        with patch.dict("os.environ", {"LLM_API_KEY": "", "OPENAI_API_KEY": ""}, clear=False):
            events = await collect_events(ChatStreamRequest(input="hello", session_id="s_provider"))

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
            events = await collect_events(
                ChatStreamRequest(
                    input="hello",
                    previous_response_id="resp_prev",
                    session_id="s_provider",
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

    async def test_empty_stream_emits_error_event(self) -> None:
        """Verify a provider stream with no events is surfaced as an error."""

        with (
            patch.dict("os.environ", {"LLM_API_KEY": "test-key"}, clear=False),
            patch.object(openai_responses_module, "AsyncOpenAI", FakeOpenAI),
        ):
            events = await collect_events(ChatStreamRequest(input="hello", session_id="s_provider"))

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
            events = await collect_events(ChatStreamRequest(input="hello", session_id="s_provider"))

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
            events = await collect_events(ChatStreamRequest(input="hello", session_id="s_provider"))

        self.assertEqual([event.type for event in events], ["text_delta", "error"])
        self.assertEqual(events[-1].message, "LLM stream ended without a terminal event")


class ChatRouteTest(unittest.TestCase):
    def test_to_sse_serializes_event_name_and_json_payload(self) -> None:
        """Verify route-level SSE serialization stays stable."""

        frame = to_sse(ChatStreamEvent(type="text_delta", delta="hi"))

        self.assertTrue(frame.startswith("event: text_delta\n"))
        self.assertIn('"delta":"hi"', frame)
        self.assertTrue(frame.endswith("\n\n"))

    def test_route_reuses_session_state_across_requests(self) -> None:
        """Verify /api/chat/stream resumes a session through the shared runtime."""

        old_runtime = chat_route_module.chat_runtime
        store = InMemorySessionStateStore()
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_route"),
            ]
        )
        chat_route_module.chat_runtime = ChatRuntime(provider=provider, session_store=store)

        try:
            client = TestClient(app)
            first = client.post("/api/chat/stream", json={"input": "first", "session_id": "s_route"})
            second = client.post("/api/chat/stream", json={"input": "second", "session_id": "s_route"})
        finally:
            chat_route_module.chat_runtime = old_runtime

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(provider.calls[0]["previous_response_id"], None)
        self.assertEqual(provider.calls[1]["previous_response_id"], "resp_route")
        self.assertIn("event: response_completed", second.text)


class InMemorySessionStateStoreTest(unittest.TestCase):
    def test_store_get_set_clear_and_overwrite(self) -> None:
        """Verify the in-memory session store keeps only the latest response ID."""

        store = InMemorySessionStateStore()

        self.assertIsNone(store.get_previous_response_id("s1"))

        store.set_previous_response_id("s1", "resp_1")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_1")

        store.set_previous_response_id("s1", "resp_2")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_2")

        store.clear("s1")
        self.assertIsNone(store.get_previous_response_id("s1"))


class SQLiteSessionStateStoreTest(unittest.TestCase):
    def test_store_persists_across_instances(self) -> None:
        """Verify the SQLite store keeps session state across store instances."""

        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "session_state.sqlite3"
            first_store = SQLiteSessionStateStore(db_path)

            self.assertIsNone(first_store.get_previous_response_id("s1"))

            first_store.set_previous_response_id("s1", "resp_1")
            second_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(second_store.get_previous_response_id("s1"), "resp_1")

            second_store.set_previous_response_id("s1", "resp_2")
            third_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(third_store.get_previous_response_id("s1"), "resp_2")

            third_store.clear("s1")
            self.assertIsNone(SQLiteSessionStateStore(db_path).get_previous_response_id("s1"))


class ChatRuntimeSessionStateTest(unittest.IsolatedAsyncioTestCase):
    async def test_runtime_uses_session_store_when_previous_response_id_is_missing(self) -> None:
        """Verify session_id resumes from the store when no explicit previous ID is sent."""

        store = InMemorySessionStateStore()
        store.set_previous_response_id("s1", "resp_prev")
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_next"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        events = [
            event async for event in runtime.stream_chat(ChatStreamRequest(input="next", session_id="s1"))
        ]

        self.assertEqual(provider.calls[0]["previous_response_id"], "resp_prev")
        self.assertEqual(events[0].session_id, "s1")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_next")

    async def test_runtime_prefers_explicit_previous_response_id(self) -> None:
        """Verify explicit previous_response_id overrides stored session state."""

        store = InMemorySessionStateStore()
        store.set_previous_response_id("s1", "resp_stored")
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_next"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        events = [
            event
            async for event in runtime.stream_chat(
                ChatStreamRequest(
                    input="next",
                    session_id="s1",
                    previous_response_id="resp_explicit",
                )
            )
        ]

        self.assertEqual(provider.calls[0]["previous_response_id"], "resp_explicit")
        self.assertEqual(events[0].session_id, "s1")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_next")

    async def test_runtime_does_not_update_store_on_error(self) -> None:
        """Verify failed turns do not poison the stored previous_response_id."""

        store = InMemorySessionStateStore()
        store.set_previous_response_id("s1", "resp_prev")
        provider = FakeProvider(
            [
                ChatStreamEvent(type="error", message="boom"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        events = [
            event async for event in runtime.stream_chat(ChatStreamRequest(input="next", session_id="s1"))
        ]

        self.assertEqual(events[0].type, "error")
        self.assertEqual(events[0].session_id, "s1")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_prev")

    async def test_runtime_creates_session_id_when_missing(self) -> None:
        """Verify a request without session_id receives a generated session_created event."""

        store = InMemorySessionStateStore()
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_new"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        events = [
            event async for event in runtime.stream_chat(ChatStreamRequest(input="start"))
        ]

        self.assertEqual(events[0].type, "session_created")
        self.assertIsNotNone(events[0].session_id)
        self.assertEqual(events[1].session_id, events[0].session_id)
        self.assertEqual(
            store.get_previous_response_id(events[0].session_id or ""),
            "resp_new",
        )


if __name__ == "__main__":
    unittest.main()
