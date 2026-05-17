import unittest

from pydantic import ValidationError

from kodeks.runtime.chat_runtime import ChatRuntime
from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatProviderRequest
from kodeks.runtime.session_state import InMemorySessionStateStore
from kodeks.schemas.chat import ChatStreamRequest


class FakeProvider:
    """Provider test double for runtime-level session tests."""

    def __init__(self, events: list[ChatStreamEvent]) -> None:
        self.events = events
        self.calls: list[ChatProviderRequest] = []

    async def stream_response(self, request: ChatProviderRequest):
        """Record runtime inputs and yield configured events."""

        self.calls.append(request)
        for event in self.events:
            yield event


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

        self.assertEqual(provider.calls[0].previous_response_id, "resp_prev")
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

        self.assertEqual(provider.calls[0].previous_response_id, "resp_explicit")
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

    async def test_runtime_does_not_mutate_provider_events(self) -> None:
        """Verify runtime enriches events without changing provider-owned objects."""

        provider_event = ChatStreamEvent(type="response_completed", response_id="resp_next")
        provider = FakeProvider([provider_event])
        runtime = ChatRuntime(provider=provider, session_store=InMemorySessionStateStore())

        events = [
            event async for event in runtime.stream_chat(ChatStreamRequest(input="next", session_id="s1"))
        ]

        self.assertIsNone(provider_event.session_id)
        self.assertIsNot(events[0], provider_event)
        self.assertEqual(events[0].session_id, "s1")

    def test_tool_call_event_requires_structured_tool_fields(self) -> None:
        """Verify tool_call cannot be emitted as a loose type-only event."""

        with self.assertRaises(ValidationError):
            ChatStreamEvent(type="tool_call")

        event = ChatStreamEvent(
            type="tool_call",
            tool_call_id="call_1",
            tool_name="read_file",
            tool_arguments={"path": "README.md"},
        )

        self.assertEqual(event.tool_name, "read_file")

    def test_tool_result_event_requires_output_and_status(self) -> None:
        """Verify tool_result carries the result fields needed by tool orchestration."""

        with self.assertRaises(ValidationError):
            ChatStreamEvent(type="tool_result", tool_call_id="call_1", tool_name="read_file")

        event = ChatStreamEvent(
            type="tool_result",
            tool_call_id="call_1",
            tool_name="read_file",
            tool_output="# kodeks",
            tool_status="completed",
        )

        self.assertEqual(event.tool_status, "completed")


if __name__ == "__main__":
    unittest.main()
