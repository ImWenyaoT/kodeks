import json

import pytest

from kodeks.agents_events import (
    AgentsSdkApprovalMetadata,
    approval_from_sdk_item,
    read_agents_sdk_approval,
    read_agents_sdk_text_delta,
    read_agents_sdk_tool_call,
    read_agents_sdk_tool_result,
)
from kodeks.agents_runtime import (
    build_agents_sdk_agent,
    create_agents_sdk_run_config,
    to_agents_sdk_input_items,
)
from kodeks.storage import KodeksDatabase


def test_build_agents_sdk_agent_wraps_local_tools(tmp_path):
    """Agents SDK agent construction preserves tool names and default non-strict schemas."""

    database = KodeksDatabase(":memory:")
    try:
        agent = build_agents_sdk_agent(
            database=database,
            workspace_root=str(tmp_path),
            model="gpt-test",
            session_id="sess_agents",
        )

        assert agent.name == "Kodeks Build Agent"
        assert agent.model == "gpt-test"
        assert "You are Kodeks" in str(agent.instructions)
        assert [tool.name for tool in agent.tools] == [
            "read_file",
            "write_file",
            "grep",
            "run_shell",
            "remember_fact",
            "recall_memory",
            "read_memory_artifact",
            "spawn_explore_agent",
            "list_mcp_servers",
            "list_skills",
            "read_skill",
        ]
        assert all(tool.strict_json_schema is False for tool in agent.tools)
    finally:
        database.close()


def test_build_agents_sdk_agent_filters_plan_tools_and_strict_mode(tmp_path):
    """Plan mode exposes read-only tools and strict schemas only when explicitly enabled."""

    database = KodeksDatabase(":memory:")
    try:
        agent = build_agents_sdk_agent(
            database=database,
            workspace_root=str(tmp_path),
            mode="plan",
            environment={"KODEKS_STRICT_TOOL_SCHEMAS": "true"},
        )

        assert [tool.name for tool in agent.tools] == [
            "read_file",
            "grep",
            "recall_memory",
            "read_memory_artifact",
            "spawn_explore_agent",
            "list_mcp_servers",
            "list_skills",
            "read_skill",
        ]
        assert all(tool.strict_json_schema is True for tool in agent.tools)
    finally:
        database.close()


@pytest.mark.asyncio
async def test_agents_sdk_run_shell_approval_records_durable_state(tmp_path):
    """Dangerous run_shell calls create approvals before SDK execution is resumed."""

    database = KodeksDatabase(":memory:")
    approval_state: dict[str, AgentsSdkApprovalMetadata] = {}
    try:
        agent = build_agents_sdk_agent(
            database=database,
            workspace_root=str(tmp_path),
            session_id="sess_agents",
            approval_state=approval_state,
        )
        run_shell = next(tool for tool in agent.tools if tool.name == "run_shell")
        assert callable(run_shell.needs_approval)

        needs_approval = await run_shell.needs_approval(
            None, {"command": "rm -rf output"}, "call_shell"
        )

        assert needs_approval is True
        approval = database.approvals.get_approval(
            approval_state["call_shell"].approval_id
        )
        assert approval.status == "pending"
        assert approval.tool_call_id == "call_shell"
        assert database.connection.execute(
            "SELECT COUNT(*) FROM audit_log"
        ).fetchone()[0] == 1
    finally:
        database.close()


@pytest.mark.asyncio
async def test_agents_sdk_tool_wrapper_invokes_local_registry(tmp_path):
    """FunctionTool invocation executes the local deterministic registry."""

    (tmp_path / "README.md").write_text("hello from sdk\n")
    database = KodeksDatabase(":memory:")
    try:
        agent = build_agents_sdk_agent(
            database=database,
            workspace_root=str(tmp_path),
            session_id="sess_agents",
        )
        read_file = next(tool for tool in agent.tools if tool.name == "read_file")

        output = await read_file.on_invoke_tool(
            None, json.dumps({"path": "README.md"})
        )

        assert json.loads(output)["content"] == "hello from sdk\n"
    finally:
        database.close()


def test_to_agents_sdk_input_items_skips_tool_rows(tmp_path):
    """Agents SDK input replay omits persisted local tool rows."""

    database = KodeksDatabase(":memory:")
    try:
        database.sessions.create_session(
            "Agents", "act", str(tmp_path), session_id="sess_agents"
        )
        database.sessions.append_message("sess_agents", "user", "hi")
        database.sessions.append_message("sess_agents", "assistant", {"text": "hello"})
        database.sessions.append_message(
            "sess_agents",
            "tool",
            {"text": "tool output", "toolCallId": "call_1", "name": "read_file"},
        )

        assert to_agents_sdk_input_items(
            database.sessions.get_transcript("sess_agents")
        ) == [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "hi"}],
            },
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": "hello",
                        "annotations": [],
                    }
                ],
            },
        ]
    finally:
        database.close()


def test_agents_sdk_event_readers_accept_sdk_like_objects():
    """SDK stream event readers preserve the existing TS event mapping contract."""

    text_event = {"data": {"type": "response.output_text.delta", "delta": "hi"}}
    call_event = {
        "type": "run_item_stream_event",
        "name": "tool_called",
        "item": {
            "rawItem": {
                "call_id": "call_read",
                "name": "read_file",
                "arguments": json.dumps({"path": "README.md"}),
            }
        },
    }
    result_event = {
        "type": "run_item_stream_event",
        "name": "tool_output",
        "item": {
            "rawItem": {"call_id": "call_shell", "name": "run_shell"},
            "output": json.dumps({"approvalRequired": True}),
        },
    }
    approval_state = {
        "call_shell": AgentsSdkApprovalMetadata(
            approval_id="appr_1",
            tool_call_id="call_shell",
            reason="Command requires approval",
        )
    }
    approval_event = {
        "type": "run_item_stream_event",
        "name": "tool_approval_requested",
        "item": {"rawItem": {"call_id": "call_shell"}},
    }

    assert read_agents_sdk_text_delta(text_event) == "hi"
    assert read_agents_sdk_tool_call(call_event) == {
        "id": "call_read",
        "name": "read_file",
        "args": {"path": "README.md"},
    }
    tool_result = read_agents_sdk_tool_result(result_event)
    assert tool_result is not None
    assert tool_result["id"] == "call_shell"
    assert tool_result["name"] == "run_shell"
    assert json.loads(tool_result["output"]) == {"approvalRequired": True}
    assert tool_result["status"] == "approval_required"
    assert read_agents_sdk_approval(approval_event, approval_state) == approval_state[
        "call_shell"
    ]
    assert approval_from_sdk_item(
        {"rawItem": {"call_id": "call_missing"}}, {}
    ) == AgentsSdkApprovalMetadata(
        approval_id="call_missing",
        tool_call_id="call_missing",
        reason="Tool call requires approval",
    )


def test_create_agents_sdk_run_config_pins_responses_provider():
    """RunConfig keeps the live Agents SDK fallback on Responses API semantics."""

    config = create_agents_sdk_run_config(
        api_key="sk-test", base_url="https://example.test/v1", reasoning_effort="low"
    )

    assert config.tracing_disabled is True
    assert config.trace_include_sensitive_data is False
    assert config.workflow_name == "Kodeks chat turn"
    assert config.model_settings is not None
    assert config.model_settings.reasoning is not None
    assert config.model_settings.reasoning.effort == "low"
