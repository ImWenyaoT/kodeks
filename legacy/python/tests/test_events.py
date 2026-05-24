import unittest

from pydantic import ValidationError

from kodeks.runtime.events import ChatStreamEvent


class ChatStreamEventTest(unittest.TestCase):
    def test_basic_event_types_require_their_payload_fields(self) -> None:
        """Verify invalid stream event states fail before reaching transports."""

        invalid_events = [
            {"type": "session_created"},
            {"type": "text_delta"},
            {"type": "response_completed"},
            {"type": "error"},
        ]

        for payload in invalid_events:
            with self.subTest(payload=payload):
                with self.assertRaises(ValidationError):
                    ChatStreamEvent(**payload)

    def test_valid_empty_text_delta_is_allowed(self) -> None:
        """Verify an empty text delta is distinct from a missing delta."""

        event = ChatStreamEvent(type="text_delta", delta="")

        self.assertEqual(event.delta, "")


if __name__ == "__main__":
    unittest.main()
