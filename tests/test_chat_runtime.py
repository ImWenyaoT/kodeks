import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from pydantic import ValidationError

import kodeks.services.workspace_service as workspace_service
import kodeks.services.audit_service as audit_service
import kodeks.services.shell_service as shell_service
from kodeks.runtime.chat_runtime import ChatRuntime
from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatProviderRequest
from kodeks.runtime.session_state import InMemorySessionStateStore
from kodeks.services.memory_service import InMemoryMemoryStore
from kodeks.schemas.chat import ChatStreamRequest


class FakeProvider:
    """Provider test double for runtime-level session and tool-loop tests."""

    def __init__(self, events: list[ChatStreamEvent] | list[list[ChatStreamEvent]]) -> None:
        self.event_turns = self._normalize_event_turns(events)
        self.calls: list[ChatProviderRequest] = []

    async def stream_response(self, request: ChatProviderRequest):
        """Record runtime inputs and yield configured events."""

        self.calls.append(request)
        events = self.event_turns[len(self.calls) - 1]
        for event in events:
            yield event

    def _normalize_event_turns(
        self,
        events: list[ChatStreamEvent] | list[list[ChatStreamEvent]],
    ) -> list[list[ChatStreamEvent]]:
        """Normalize one-turn and multi-turn fake streams for tests."""

        if not events:
            return [[]]

        if isinstance(events[0], list):
            return events

        return [events]


class ChatRuntimeSessionStateTest(unittest.IsolatedAsyncioTestCase):
    async def test_runtime_uses_session_store_when_previous_response_id_is_missing(self) -> None:
        """Verify session_id resumes from the store when no explicit previous ID is sent."""

        store = InMemorySessionStateStore()
        await store.set_previous_response_id("s1", "resp_prev")
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
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_next")

    async def test_runtime_prefers_explicit_previous_response_id(self) -> None:
        """Verify explicit previous_response_id overrides stored session state."""

        store = InMemorySessionStateStore()
        await store.set_previous_response_id("s1", "resp_stored")
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
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_next")

    async def test_runtime_does_not_update_store_on_error(self) -> None:
        """Verify failed turns do not poison the stored previous_response_id."""

        store = InMemorySessionStateStore()
        await store.set_previous_response_id("s1", "resp_prev")
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
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_prev")

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
            await store.get_previous_response_id(events[0].session_id or ""),
            "resp_new",
        )

    async def test_runtime_records_session_transcript(self) -> None:
        """Verify multi-session state includes a minimal resumable transcript."""

        store = InMemorySessionStateStore()
        provider = FakeProvider(
            [
                ChatStreamEvent(type="text_delta", delta="hello"),
                ChatStreamEvent(type="response_completed", response_id="resp_1"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        [
            event
            async for event in runtime.stream_chat(
                ChatStreamRequest(input="hi", session_id="s1")
            )
        ]

        transcript = await store.get_transcript("s1")
        self.assertEqual(transcript[0]["role"], "user")
        self.assertEqual(transcript[0]["content"], "hi")
        self.assertEqual(transcript[-1]["role"], "assistant")
        self.assertEqual(transcript[-1]["content"], "hello")

    async def test_runtime_injects_relevant_memory_into_provider_input(self) -> None:
        """Verify long-term memory recall is assembled into the model input."""

        memory_store = InMemoryMemoryStore()
        memory_store.remember("User prefers pytest for Python validation.", scope="user")
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_1"),
            ]
        )
        runtime = ChatRuntime(
            provider=provider,
            session_store=InMemorySessionStateStore(),
            memory_store=memory_store,
        )

        [
            event
            async for event in runtime.stream_chat(
                ChatStreamRequest(input="write pytest coverage", session_id="s1")
            )
        ]

        self.assertIn("<relevant_memory>", provider.calls[0].user_input)
        self.assertIn("User prefers pytest", provider.calls[0].user_input)
        self.assertIn("write pytest coverage", provider.calls[0].user_input)

    async def test_runtime_builds_chat_messages_from_transcript(self) -> None:
        """Verify chat-completions providers receive resumable message history."""

        store = InMemorySessionStateStore()
        await store.append_transcript_event("s1", "user", "previous question")
        await store.append_transcript_event("s1", "assistant", "previous answer")
        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_1"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=store)

        [
            event
            async for event in runtime.stream_chat(
                ChatStreamRequest(input="next question", session_id="s1")
            )
        ]

        self.assertEqual(
            [message.model_dump(exclude_none=True) for message in provider.calls[0].messages],
            [
                {"role": "user", "content": "previous question"},
                {"role": "assistant", "content": "previous answer"},
                {"role": "user", "content": "next question"},
            ],
        )

    async def test_plan_mode_exposes_only_non_mutating_tools(self) -> None:
        """Verify plan mode prevents the model from receiving mutating tools."""

        provider = FakeProvider(
            [
                ChatStreamEvent(type="response_completed", response_id="resp_plan"),
            ]
        )
        runtime = ChatRuntime(provider=provider, session_store=InMemorySessionStateStore())

        [
            event
            async for event in runtime.stream_chat(
                ChatStreamRequest(input="make a plan", session_id="s1", mode="plan")
            )
        ]

        tool_names = [tool.name for tool in provider.calls[0].tools]
        self.assertIn("read_file", tool_names)
        self.assertIn("recall_memory", tool_names)
        self.assertIn("spawn_subagent", tool_names)
        self.assertNotIn("write_file", tool_names)
        self.assertNotIn("run_shell", tool_names)
        self.assertIn("<plan_mode>", provider.calls[0].user_input)

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

    async def test_runtime_executes_read_file_tool_loop(self) -> None:
        """Verify runtime turns a model tool_call into local read_file execution."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "README.md").write_text("# kodeks", encoding="utf-8")
            store = InMemorySessionStateStore()
            provider = FakeProvider(
                [
                    [
                        ChatStreamEvent(
                            type="tool_call",
                            tool_call_id="call_1",
                            tool_name="read_file",
                            tool_arguments={"path": "README.md"},
                        ),
                        ChatStreamEvent(type="response_completed", response_id="resp_tool"),
                    ],
                    [
                        ChatStreamEvent(type="text_delta", delta="README says kodeks"),
                        ChatStreamEvent(type="response_completed", response_id="resp_final"),
                    ],
                ]
            )
            runtime = ChatRuntime(provider=provider, session_store=store)

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                events = [
                    event
                    async for event in runtime.stream_chat(
                        ChatStreamRequest(input="read README", session_id="s1")
                    )
                ]

        self.assertEqual(
            [event.type for event in events],
            ["tool_call", "tool_result", "text_delta", "response_completed"],
        )
        self.assertEqual(events[1].tool_status, "completed")
        self.assertIn("# kodeks", events[1].tool_output or "")
        self.assertEqual(provider.calls[0].tools[0].name, "read_file")
        self.assertEqual(
            provider.calls[1].messages[-1].model_dump(exclude_none=True),
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path":"README.md"}',
                        },
                    }
                ],
            },
        )
        self.assertEqual(provider.calls[1].tool_outputs[0].tool_call_id, "call_1")
        self.assertIn("# kodeks", provider.calls[1].tool_outputs[0].output)
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_final")

    async def test_runtime_does_not_store_intermediate_tool_response_id(self) -> None:
        """Verify failed final turns do not save the intermediate tool-call response."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "README.md").write_text("# kodeks", encoding="utf-8")
            store = InMemorySessionStateStore()
            await store.set_previous_response_id("s1", "resp_prev")
            provider = FakeProvider(
                [
                    [
                        ChatStreamEvent(
                            type="tool_call",
                            tool_call_id="call_1",
                            tool_name="read_file",
                            tool_arguments={"path": "README.md"},
                        ),
                        ChatStreamEvent(type="response_completed", response_id="resp_tool"),
                    ],
                    [
                        ChatStreamEvent(type="error", message="provider failed"),
                    ],
                ]
            )
            runtime = ChatRuntime(provider=provider, session_store=store)

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                events = [
                    event
                    async for event in runtime.stream_chat(
                        ChatStreamRequest(input="read README", session_id="s1")
                    )
                ]

        self.assertEqual(events[-1].type, "error")
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_prev")

    async def test_runtime_emits_failed_tool_result_for_blocked_path(self) -> None:
        """Verify local tool failures are visible as tool_result events."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            git_dir = root / ".git"
            git_dir.mkdir()
            (git_dir / "config").write_text("secret", encoding="utf-8")
            provider = FakeProvider(
                [
                    [
                        ChatStreamEvent(
                            type="tool_call",
                            tool_call_id="call_1",
                            tool_name="read_file",
                            tool_arguments={"path": ".git/config"},
                        ),
                        ChatStreamEvent(type="response_completed", response_id="resp_tool"),
                    ],
                    [
                        ChatStreamEvent(type="response_completed", response_id="resp_final"),
                    ],
                ]
            )
            runtime = ChatRuntime(provider=provider, session_store=InMemorySessionStateStore())

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                events = [
                    event
                    async for event in runtime.stream_chat(
                        ChatStreamRequest(input="read git config", session_id="s1")
                    )
                ]

        self.assertEqual(events[1].type, "tool_result")
        self.assertEqual(events[1].tool_status, "failed")
        self.assertIn("Path is blocked", events[1].tool_output or "")
        self.assertIn("Path is blocked", provider.calls[1].tool_outputs[0].output)

    async def test_runtime_executes_write_file_tool_loop(self) -> None:
        """Verify runtime can execute the Phase 5B write_file tool."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            store = InMemorySessionStateStore()
            provider = FakeProvider(
                [
                    [
                        ChatStreamEvent(
                            type="tool_call",
                            tool_call_id="call_write",
                            tool_name="write_file",
                            tool_arguments={
                                "path": "output/agent.txt",
                                "content": "written by agent",
                            },
                        ),
                        ChatStreamEvent(type="response_completed", response_id="resp_tool"),
                    ],
                    [
                        ChatStreamEvent(type="response_completed", response_id="resp_final"),
                    ],
                ]
            )
            runtime = ChatRuntime(provider=provider, session_store=store)

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                events = [
                    event
                    async for event in runtime.stream_chat(
                        ChatStreamRequest(input="write file", session_id="s1")
                    )
                ]
                written = workspace_service.read_file("output/agent.txt")

        self.assertEqual(written, "written by agent")
        self.assertEqual(events[1].type, "tool_result")
        self.assertEqual(events[1].tool_status, "completed")
        self.assertIn("whole_file_overwrite", events[1].tool_output or "")
        self.assertIn("whole_file_overwrite", provider.calls[1].tool_outputs[0].output)
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_final")

    async def test_runtime_pauses_dangerous_shell_tool_and_records_audit(self) -> None:
        """Verify dangerous shell tool calls produce approval_required without execution."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            provider = FakeProvider(
                [
                    [
                        ChatStreamEvent(
                            type="tool_call",
                            tool_call_id="call_shell",
                            tool_name="run_shell",
                            tool_arguments={"command": "rm -rf output"},
                        ),
                        ChatStreamEvent(type="response_completed", response_id="resp_tool"),
                    ],
                    [
                        ChatStreamEvent(type="response_completed", response_id="resp_final"),
                    ],
                ]
            )
            runtime = ChatRuntime(provider=provider, session_store=InMemorySessionStateStore())

            with (
                patch.object(workspace_service, "WORKSPACE_ROOT", root),
                patch.object(shell_service, "WORKSPACE_ROOT", root),
                patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path),
            ):
                events = [
                    event
                    async for event in runtime.stream_chat(
                        ChatStreamRequest(input="delete output", session_id="s1")
                    )
                ]

            records = [
                json.loads(line)
                for line in audit_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(events[1].type, "tool_result")
        self.assertEqual(events[1].tool_status, "approval_required")
        self.assertIn("approval_id", events[1].tool_output or "")
        self.assertIn("approval_required", provider.calls[1].tool_outputs[0].output)
        self.assertEqual(records[0]["session_id"], "s1")
        self.assertEqual(records[0]["tool_call_id"], "call_shell")

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
