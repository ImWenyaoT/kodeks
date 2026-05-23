import unittest

import kodeks.api.routes.chat as chat_route_module
from fastapi.testclient import TestClient
from kodeks.api.routes.chat import to_sse
from kodeks.main import app
from kodeks.runtime.chat_runtime import ChatRuntime
from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatProviderRequest
from kodeks.runtime.session_state import InMemorySessionStateStore


class FakeProvider:
    """Provider test double for route-level streaming tests."""

    def __init__(self, events: list[ChatStreamEvent]) -> None:
        self.events = events
        self.calls: list[ChatProviderRequest] = []

    async def stream_response(self, request: ChatProviderRequest):
        """Record provider requests and yield configured events."""

        self.calls.append(request)
        for event in self.events:
            yield event


class ChatRouteTest(unittest.TestCase):
    def test_to_sse_serializes_event_name_and_json_payload(self) -> None:
        """Verify route-level SSE serialization stays stable."""

        frame = to_sse(ChatStreamEvent(type="text_delta", delta="hi"))

        self.assertTrue(frame.startswith("event: text_delta\n"))
        self.assertIn('"delta":"hi"', frame)
        self.assertTrue(frame.endswith("\n\n"))

    def test_to_sse_caches_static_error_frames(self) -> None:
        """Verify repeat static error events reuse serialized SSE frames."""

        chat_route_module._SSE_FRAME_CACHE.clear()
        first_frame = to_sse(ChatStreamEvent(type="error", message="static error"))
        second_frame = to_sse(ChatStreamEvent(type="error", message="static error"))

        self.assertEqual(first_frame, second_frame)
        self.assertEqual(len(chat_route_module._SSE_FRAME_CACHE), 1)

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
        self.assertEqual(provider.calls[0].previous_response_id, None)
        self.assertEqual(provider.calls[1].previous_response_id, "resp_route")
        self.assertIn("event: response_completed", second.text)


if __name__ == "__main__":
    unittest.main()
