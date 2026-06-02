import json

import pytest
from fastapi.testclient import TestClient

from kodeks.app import create_app
from kodeks.plans import build_plan_artifact_content
from kodeks.runtime import (
    build_plan_artifact_content as runtime_build_plan_artifact_content,
)
from kodeks.runtime import (
    run_python_chat_turn,
)
from kodeks.storage import KodeksDatabase


def _responses_events(body, env):
    """Request one file tool, then answer after the tool output is replayed."""

    if _has_function_call_output(body):
        return [
            {
                "type": "response.output_text.delta",
                "delta": "Done.",
            },
            {
                "type": "response.completed",
                "response": {"id": "resp_final", "status": "completed"},
            },
        ]
    return [
        {
            "type": "response.output_text.delta",
            "delta": "Reading...",
        },
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_read",
                "name": "read_file",
                "arguments": json.dumps({"path": "README.md"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_tool", "status": "completed"},
        },
    ]


def _approval_events(body, env):
    """Request a shell approval to verify the turn pauses locally."""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_shell",
                "name": "run_shell",
                "arguments": json.dumps({"command": "rm -rf output"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_approval", "status": "completed"},
        },
    ]


def _large_tool_events(body, env):
    """Request a large file read, then finish after artifact replay."""

    if _has_function_call_output(body):
        return [
            {
                "type": "response.completed",
                "response": {"id": "resp_large", "status": "completed"},
            },
        ]
    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_large",
                "name": "read_file",
                "arguments": json.dumps({"path": "large.txt"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_large", "status": "completed"},
        },
    ]


def _unknown_tool_events(body, env):
    """Request an unavailable tool to verify local runtime halt behavior."""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_glob",
                "name": "glob",
                "arguments": json.dumps({"pattern": "**/*.ts"}),
            },
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_unknown", "status": "completed"},
        },
    ]


def _stream_error_events(body, env):
    """Emit a direct Responses error event from the model stream."""

    return [{"type": "error", "message": "upstream stream error"}]


def _has_function_call_output(body):
    """Return whether a replay body already includes a tool output item."""

    replay_input = body.get("input")
    return isinstance(replay_input, list) and any(
        isinstance(item, dict) and item.get("type") == "function_call_output"
        for item in replay_input
    )


def _capture_only_events(captured):
    """Capture the runtime body while returning a completed model turn."""

    def events(body, env):
        captured.append(body)
        return [{"type": "response.completed", "response": {"id": "resp_capture"}}]

    return events


def _plan_events(body, env):
    return [
        {
            "type": "response.output_text.delta",
            "delta": "# Storage plan\n\nPersist a plan artifact.\n\n1. Add a plans table\n2. Restore it next turn",
        },
        {
            "type": "response.completed",
            "response": {"id": "resp_plan", "status": "completed"},
        },
    ]


class FakeAgentsSdkResult:
    """Minimal streaming result used to test the Python Agents SDK branch."""

    def __init__(
        self,
        events,
        final_output="Hello from SDK",
        last_response_id="resp_agents",
        interruptions=None,
    ):
        self.events = events
        self.final_output = final_output
        self.last_response_id = last_response_id
        self.interruptions = interruptions or []

    async def stream_events(self):
        """Yield fake SDK stream events in order."""

        for event in self.events:
            yield event


class FakeAgentsSdkRunner:
    """Captures the SDK runner call while returning deterministic stream events."""

    def __init__(self, events):
        self.events = events
        self.agent = None
        self.input = None
        self.kwargs = None

    def run_streamed(self, starting_agent, input, **kwargs):
        """Return a fake stream result and record the runner invocation."""

        self.agent = starting_agent
        self.input = input
        self.kwargs = kwargs
        return FakeAgentsSdkResult(self.events)


@pytest.mark.asyncio
async def test_python_chat_loop_streams_text_tools_and_persists_session(tmp_path):
    """Injected Responses events drive the Python loop without external models."""

    (tmp_path / "README.md").write_text("hello from workspace\n")
    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "read it", "session_id": "sess_py"},
                database,
                str(tmp_path),
                {},
                _responses_events,
            )
        ]

        assert [event["type"] for event in events] == [
            "session_created",
            "text_delta",
            "assistant_status",
            "tool_call",
            "tool_result",
            "text_delta",
            "response_completed",
        ]
        assert events[3]["tool_name"] == "read_file"
        assert events[4]["tool_status"] == "ok"
        assert events[5]["delta"] == "Done."
        assert "hello from workspace" in events[4]["tool_output"]
        assert database.sessions.get_session("sess_py") is not None
        transcript = database.sessions.get_transcript("sess_py")
        assert [message.role for message in transcript] == [
            "user",
            "assistant",
            "tool",
            "assistant",
        ]
        assert transcript[1].content["text"] == "Reading..."
        assert transcript[1].content["toolCalls"] == [
            {
                "id": "call_read",
                "name": "read_file",
                "args": {"path": "README.md"},
            }
        ]
        assert transcript[2].role == "tool"
        assert transcript[2].content["toolCallId"] == "call_read"
        assert "hello from workspace" in transcript[2].content["text"]
        assert transcript[3].content == "Done."
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_can_use_agents_sdk_diagnostics(tmp_path):
    """The diagnostics flag routes through the Agents SDK adapter."""

    runner = FakeAgentsSdkRunner(
        [
            {
                "type": "raw_model_stream_event",
                "data": {"type": "output_text_delta", "delta": "Hello"},
            },
            {
                "type": "raw_model_stream_event",
                "data": {"type": "output_text_delta", "delta": " from SDK"},
            },
        ]
    )
    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "hello", "session_id": "sess_agents"},
                database,
                str(tmp_path),
                {
                    "KODEKS_FORCE_AGENTS_SDK_RUNTIME": "true",
                    "KODEKS_MODEL_PROVIDER": "moonbridge",
                    "KODEKS_CHAT_COMPLETIONS_API_KEY": "sk-test",
                    "KODEKS_CHAT_COMPLETIONS_MODEL": "deepseek-v4-pro",
                },
                None,
                runner,
            )
        ]

        assert [event["type"] for event in events] == [
            "session_created",
            "text_delta",
            "text_delta",
            "response_completed",
        ]
        assert events[1]["delta"] == "Hello"
        assert events[2]["delta"] == " from SDK"
        assert events[3]["response_id"] == "resp_agents"
        assert runner.agent.name == "Kodeks Build Agent"
        assert runner.input == [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "hello"}],
            }
        ]
        assert runner.kwargs["max_turns"] == 12
        assert runner.kwargs["previous_response_id"] is None
        transcript = database.sessions.get_transcript("sess_agents")
        assert [message.role for message in transcript] == ["user", "assistant"]
        assert transcript[1].content == "Hello from SDK"
        assert transcript[1].agent_event == {"responseId": "resp_agents"}
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_rejects_direct_responses_provider(
    tmp_path, monkeypatch
):
    """Direct OpenAI/Responses runtime is no longer a configured provider path."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "hello", "session_id": "sess_direct"},
                database,
                str(tmp_path),
                {
                    "KODEKS_MODEL_PROVIDER": "openai",
                },
            )
        ]

        assert [event["type"] for event in events] == [
            "session_created",
            "error",
        ]
        assert events[1]["code"] == "model_configuration_error"
        assert (
            "Direct OpenAI/Responses model providers have been removed"
            in events[1]["message"]
        )
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_routes_chat_completions_through_bridge_adapter(
    tmp_path, monkeypatch
):
    """DeepSeek Chat Completions models use the Python bridge adapter."""

    async def fake_fetch_chat_completions_stream(payload, api_key, env):
        """Yield a minimal upstream Chat Completions stream for bridge routing."""

        assert payload["model"] == "deepseek-v4-pro"
        assert api_key == "local-placeholder"
        assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "https://api.deepseek.com"
        yield {
            "id": "chatcmpl_test",
            "model": "deepseek-v4-pro",
            "choices": [
                {"index": 0, "delta": {"content": "Bridge"}, "finish_reason": None}
            ],
        }
        yield {
            "id": "chatcmpl_test",
            "model": "deepseek-v4-pro",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }

    monkeypatch.setattr(
        "kodeks.responses_runtime.fetch_chat_completions_stream",
        fake_fetch_chat_completions_stream,
    )
    runner = FakeAgentsSdkRunner([])
    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {
                    "input": "hello",
                    "session_id": "sess_bridge",
                    "model": "deepseek/deepseek-v4-pro",
                },
                database,
                str(tmp_path),
                {
                    "KODEKS_MODEL_PROVIDER": "moonbridge",
                    "KODEKS_CHAT_COMPLETIONS_API_KEY": "local-placeholder",
                    "KODEKS_CHAT_COMPLETIONS_BASE_URL": "https://api.deepseek.com",
                    "KODEKS_CHAT_COMPLETIONS_MODEL": "deepseek-v4-pro",
                },
                None,
                runner,
            )
        ]

        assert [event["type"] for event in events] == [
            "session_created",
            "text_delta",
            "response_completed",
        ]
        assert events[1]["delta"] == "Bridge"
        assert runner.agent is None
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_replays_tool_continuation_input(tmp_path):
    """Persisted tool calls and outputs are replayed as Responses input items."""

    (tmp_path / "README.md").write_text("hello from workspace\n")
    captured = []
    database = KodeksDatabase(":memory:")
    try:
        _first = [
            event
            async for event in run_python_chat_turn(
                {"input": "read it", "session_id": "sess_replay"},
                database,
                str(tmp_path),
                {},
                _responses_events,
            )
        ]
        _second = [
            event
            async for event in run_python_chat_turn(
                {"input": "continue", "session_id": "sess_replay"},
                database,
                str(tmp_path),
                {},
                _capture_only_events(captured),
            )
        ]

        replay_input = captured[0]["input"]
        assert replay_input[0]["role"] == "user"
        assert replay_input[1]["role"] == "assistant"
        assert replay_input[1]["content"] == [
            {"type": "output_text", "text": "Reading...", "annotations": []}
        ]
        assert replay_input[2]["type"] == "function_call"
        assert replay_input[2]["call_id"] == "call_read"
        assert replay_input[2]["arguments"] == '{"path":"README.md"}'
        assert replay_input[3]["type"] == "function_call_output"
        assert replay_input[3]["call_id"] == "call_read"
        assert "hello from workspace" in replay_input[3]["output"]
        assert replay_input[4]["role"] == "assistant"
        assert replay_input[4]["content"] == [
            {"type": "output_text", "text": "Done.", "annotations": []}
        ]
        assert replay_input[-1]["role"] == "user"
        assert replay_input[-1]["content"][0]["text"] == "continue"
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_stops_unknown_tool_locally(tmp_path):
    """Unknown model-requested tools emit an error and do not continue."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "find files", "session_id": "sess_unknown"},
                database,
                str(tmp_path),
                {},
                _unknown_tool_events,
            )
        ]

        assert [event["type"] for event in events] == [
            "session_created",
            "assistant_status",
            "tool_call",
            "tool_result",
            "error",
        ]
        assert events[3]["tool_status"] == "error"
        assert events[3]["tool_output"] == "Unknown tool requested by model: glob"
        assert events[4]["code"] == "model_requested_unknown_tool"
        assert [
            message.role for message in database.sessions.get_transcript("sess_unknown")
        ] == ["user"]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_maps_responses_error_events(tmp_path):
    """Direct Responses error events remain terminal runtime errors."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "hello", "session_id": "sess_error"},
                database,
                str(tmp_path),
                {},
                _stream_error_events,
            )
        ]

        assert events == [
            {"type": "session_created", "session_id": "sess_error"},
            {
                "type": "error",
                "message": "upstream stream error",
                "code": "runtime_error",
                "session_id": "sess_error",
            },
        ]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_offloads_large_tool_outputs(tmp_path):
    """Large successful tool outputs become memory artifact refs."""

    (tmp_path / "large.txt").write_text("memory artifact body " * 80)
    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "read the large file", "session_id": "sess_large"},
                database,
                str(tmp_path),
                {"KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES": "64"},
                _large_tool_events,
            )
        ]

        tool_event = next(event for event in events if event["type"] == "tool_result")
        output = json.loads(tool_event["tool_output"])
        artifact = database.memories.read_artifact_content(output["refId"])

        assert output["offloaded"] is True
        assert output["toolName"] == "read_file"
        assert len(tool_event["tool_output"]) < 1000
        assert artifact is not None
        assert "memory artifact body" in artifact["content"]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_creates_plan_artifact_in_plan_mode(tmp_path):
    """Plan-mode assistant text becomes a durable plan artifact event."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {
                    "input": "make a plan for plan artifacts",
                    "session_id": "sess_plan",
                    "mode": "plan",
                },
                database,
                str(tmp_path),
                {},
                _plan_events,
            )
        ]

        plan_event = next(event for event in events if event["type"] == "plan_artifact")
        active_plan = database.plans.get_active_by_session("sess_plan")

        assert plan_event["action"] == "created"
        assert plan_event["plan"]["title"] == "Storage plan"
        assert plan_event["plan"]["summary"] == "Persist a plan artifact."
        assert plan_event["plan"]["steps"] == [
            {
                "id": "step_1",
                "title": "Add a plans table",
                "status": "pending",
                "details": None,
            },
            {
                "id": "step_2",
                "title": "Restore it next turn",
                "status": "pending",
                "details": None,
            },
        ]
        assert active_plan is not None
        assert active_plan.title == "Storage plan"
        assert [event["type"] for event in events][-2:] == [
            "plan_artifact",
            "response_completed",
        ]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_recovers_active_plan_into_runtime_context(tmp_path):
    """Existing active plans are emitted and passed into model instructions."""

    seen_bodies = []

    def responses_events(body, env):
        seen_bodies.append(body)
        return [{"type": "response.completed", "response": {"id": "resp_resume"}}]

    database = KodeksDatabase(":memory:")
    try:
        database.sessions.create_session(
            title="Plan session",
            mode="act",
            workspace_root=str(tmp_path),
            session_id="sess_resume",
        )
        database.plans.upsert_active(
            session_id="sess_resume",
            title="Recovered plan",
            summary="Keep the next turn aligned with the stored plan.",
            steps=[
                {
                    "id": "step_1",
                    "title": "Use the active plan in context",
                    "status": "pending",
                    "details": None,
                }
            ],
        )

        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "continue", "session_id": "sess_resume"},
                database,
                str(tmp_path),
                {},
                responses_events,
            )
        ]

        assert events[1]["type"] == "plan_artifact"
        assert events[1]["action"] == "recovered"
        assert seen_bodies[0]["instructions"].find("Recovered plan") >= 0
        assert "Use the active plan in context" in seen_bodies[0]["instructions"]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_injects_recalled_memory_before_model(tmp_path):
    """Python turns emit recalled memory and add it to model instructions."""

    seen_bodies = []

    def responses_events(body, env):
        seen_bodies.append(body)
        return [{"type": "response.completed", "response": {"id": "resp_memory"}}]

    database = KodeksDatabase(":memory:")
    try:
        database.memories.remember(
            "project",
            "Kodeks uses plan mode for read-only planning.",
            "sess_memory",
        )

        events = [
            event
            async for event in run_python_chat_turn(
                {
                    "input": "how should plan mode work?",
                    "session_id": "sess_memory",
                },
                database,
                str(tmp_path),
                {},
                responses_events,
            )
        ]

        memory_event = next(
            event for event in events if event["type"] == "memory_recalled"
        )

        assert memory_event["memory_ids"][0].startswith("atom_")
        assert memory_event["memory_layers"] == {"atom": 1}
        assert "Kodeks uses plan mode" in seen_bodies[0]["instructions"]
        assert "Recalled memory:" in seen_bodies[0]["instructions"]
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_injects_selected_files_before_model(tmp_path):
    """Selected workspace files are added to runtime instructions."""

    seen_bodies = []

    def responses_events(body, env):
        seen_bodies.append(body)
        return [{"type": "response.completed", "response": {"id": "resp_selected"}}]

    database = KodeksDatabase(":memory:")
    try:
        awaitable_events = run_python_chat_turn(
            {
                "input": "use selected files",
                "session_id": "sess_selected",
                "selectedFiles": [
                    {
                        "path": "src/example.ts",
                        "content": "export const selectedMarker = true;",
                        "truncated": True,
                    },
                    {
                        "path": "missing.ts",
                        "error": "File not found",
                    },
                ],
            },
            database,
            str(tmp_path),
            {},
            responses_events,
        )
        _events = [event async for event in awaitable_events]

        instructions = seen_bodies[0]["instructions"]
        assert "Selected workspace files for this turn" in instructions
        assert "src/example.ts (truncated)" in instructions
        assert "selectedMarker" in instructions
        assert "missing.ts" in instructions
        assert "Unable to read selected file: File not found" in instructions
    finally:
        database.close()


@pytest.mark.asyncio
async def test_python_chat_loop_emits_approval_required(tmp_path):
    """Dangerous tool calls surface approval_required events and audit records."""

    database = KodeksDatabase(":memory:")
    try:
        events = [
            event
            async for event in run_python_chat_turn(
                {"input": "clean output", "session_id": "sess_py"},
                database,
                str(tmp_path),
                {},
                _approval_events,
            )
        ]

        approval = next(
            event for event in events if event["type"] == "approval_required"
        )
        tool_result = next(event for event in events if event["type"] == "tool_result")

        assert tool_result["tool_status"] == "approval_required"
        assert approval["approval_id"].startswith("appr_")
        assert (
            database.approvals.get_approval(approval["approval_id"]).status == "pending"
        )
        assert (
            database.connection.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
            == 1
        )
        assert [
            message.role for message in database.sessions.get_transcript("sess_py")
        ] == ["user"]
    finally:
        database.close()


def test_python_chat_routes_stream_runtime_and_ui_payloads(tmp_path, monkeypatch):
    """FastAPI chat routes expose runtime SSE and UI transport SSE."""

    (tmp_path / "README.md").write_text("route body\n")
    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    monkeypatch.setenv("KODEKS_WORKSPACE_ROOT", str(tmp_path))
    client = TestClient(create_app(_responses_events))

    runtime = client.post(
        "/api/chat/stream", json={"input": "read it", "session_id": "sess_route"}
    )
    ui = client.post("/api/chat/ui", json={"input": "read it", "session_id": "sess_ui"})

    assert runtime.status_code == 200
    assert "event: text_delta" in runtime.text
    assert '"tool_name":"read_file"' in runtime.text
    assert "event: response_completed" in runtime.text
    assert ui.status_code == 200
    assert "event: text-delta" in ui.text
    assert '"toolName":"read_file"' in ui.text
    assert "event: finish" in ui.text


def test_build_plan_artifact_content_matches_typescript_parser_shape():
    """Plan extraction keeps title, summary, steps, and checkbox status stable."""

    assert runtime_build_plan_artifact_content is build_plan_artifact_content
    artifact = build_plan_artifact_content(
        "fallback title",
        "# Release plan\n\nShip safely.\n\n- [x] Map current state\n- Validate parity",
    )

    assert artifact == {
        "title": "Release plan",
        "summary": "Ship safely.",
        "steps": [
            {
                "id": "step_1",
                "title": "Map current state",
                "status": "completed",
                "details": None,
            },
            {
                "id": "step_2",
                "title": "Validate parity",
                "status": "pending",
                "details": None,
            },
        ],
    }
