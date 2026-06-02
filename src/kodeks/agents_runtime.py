"""OpenAI Agents SDK compatibility helpers for the Python migration."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

from agents import Agent, FunctionTool, ModelSettings, OpenAIProvider, RunConfig, Runner
from openai.types.shared.reasoning import Reasoning

from .contracts import StoredMessage
from .storage import KodeksDatabase
from .tools import (
    ToolDefinition,
    ToolExecutionContext,
    ToolRegistry,
    ToolRegistryServices,
    build_default_tool_registry,
)
from .workspace import WorkspaceService, is_dangerous_command

MAX_AGENTS_SDK_TURNS = 12
ReasoningEffortValue = Literal["none", "minimal", "low", "medium", "high", "xhigh"]


@dataclass(frozen=True)
class AgentsSdkApprovalMetadata:
    """Durable approval metadata needed to map SDK interruptions to UI events."""

    approval_id: str
    tool_call_id: str
    reason: str


class AgentsSdkStreamResult(Protocol):
    """Streaming result shape used by real and fake Agents SDK runners."""

    final_output: Any
    last_response_id: str | None
    interruptions: list[Any]

    def stream_events(self) -> AsyncIterator[object]:
        """Yield raw SDK stream events."""


class AgentsSdkRunner(Protocol):
    """Minimal runner protocol shared by `agents.Runner` and tests."""

    def run_streamed(
        self,
        starting_agent: Agent[Any],
        input: list[dict[str, Any]],
        **kwargs: Any,
    ) -> AgentsSdkStreamResult:
        """Run one streaming Agents SDK turn."""


def build_agents_sdk_build_agent(
    *,
    database: KodeksDatabase,
    workspace_root: str,
    mode: str = "act",
    model: str | None = None,
    environment: Mapping[str, str | None] | None = None,
    session_id: str | None = None,
    memory_context: Mapping[str, list[dict[str, Any]]] | None = None,
    active_plan: Any | None = None,
    selected_files: list[dict[str, Any]] | None = None,
    instructions: str | None = None,
    registry: ToolRegistry | None = None,
    approval_state: dict[str, AgentsSdkApprovalMetadata] | None = None,
) -> Agent[Any]:
    """Build a TS-compatible OpenAI Agents SDK agent with local tool wrappers."""

    runtime_env = os.environ if environment is None else environment
    workspace = WorkspaceService(workspace_root)
    active_registry = registry or build_default_tool_registry(
        ToolRegistryServices(workspace, database, runtime_env)
    )
    read_only_only = mode == "plan"
    strict = runtime_env.get("KODEKS_STRICT_TOOL_SCHEMAS") == "true"
    approvals = approval_state if approval_state is not None else {}
    return Agent(
        name="Kodeks Build Agent",
        instructions=instructions
        or _fallback_agent_instructions(mode, memory_context, active_plan, selected_files),
        model=model,
        tools=[
            to_agents_sdk_tool(
                definition,
                active_registry,
                database=database,
                session_id=session_id,
                approval_state=approvals,
                strict=strict,
            )
            for definition in active_registry.definitions(read_only_only)
        ],
    )


def default_agents_sdk_runner() -> AgentsSdkRunner:
    """Return the real OpenAI Agents SDK streaming runner."""

    return cast(AgentsSdkRunner, Runner)


def create_agents_sdk_run_config(
    *,
    api_key: str | None,
    base_url: str | None = None,
    reasoning_effort: str | None = None,
) -> RunConfig:
    """Create an Agents SDK RunConfig pinned to the Responses API."""

    os.environ.setdefault("OPENAI_AGENTS_DISABLE_TRACING", "1")
    return RunConfig(
        model_provider=OpenAIProvider(
            api_key=api_key,
            base_url=base_url,
            use_responses=True,
        ),
        model_settings=ModelSettings(
            reasoning=Reasoning(effort=_reasoning_effort(reasoning_effort))
            if reasoning_effort
            else None
        ),
        tracing_disabled=os.environ.get("OPENAI_AGENTS_TRACING_DISABLED") != "false",
        trace_include_sensitive_data=False,
        workflow_name="Kodeks chat turn",
    )


def to_agents_sdk_input_items(transcript: Iterable[StoredMessage]) -> list[dict[str, Any]]:
    """Convert durable transcript rows into TS-compatible Agents SDK input items."""

    items: list[dict[str, Any]] = []
    for message in transcript:
        if message.role == "tool":
            continue
        text = _content_text(message.content)
        if not text.strip():
            continue
        role = "assistant" if message.role == "assistant" else "user"
        content_type = "output_text" if role == "assistant" else "input_text"
        item: dict[str, Any] = {
            "type": "message",
            "role": role,
            "content": [{"type": content_type, "text": text}],
        }
        if role == "assistant":
            item["content"][0]["annotations"] = []
        items.append(item)
    return items


def to_agents_sdk_tool(
    definition: ToolDefinition,
    registry: ToolRegistry,
    *,
    database: KodeksDatabase,
    session_id: str | None,
    approval_state: dict[str, AgentsSdkApprovalMetadata],
    strict: bool,
) -> FunctionTool:
    """Convert one local Kodeks tool definition into an Agents SDK FunctionTool."""

    async def needs_approval(
        _run_context: Any, raw_input: dict[str, Any], call_id: str
    ) -> bool:
        """Create a durable approval before the SDK interrupts a dangerous shell call."""

        if definition["name"] != "run_shell":
            return False
        command = raw_input.get("command")
        if not isinstance(command, str) or not is_dangerous_command(command):
            return False
        tool_call_id = call_id or _new_tool_call_id()
        approval = database.approvals.create_approval(
            command={"command": command},
            reason="Command requires approval",
            session_id=session_id,
            tool_call_id=tool_call_id,
        )
        database.audit_log.record(
            session_id,
            "approval_required",
            {"approvalId": approval.id, "command": command},
        )
        approval_state[tool_call_id] = AgentsSdkApprovalMetadata(
            approval_id=approval.id,
            tool_call_id=tool_call_id,
            reason=approval.reason,
        )
        return True

    async def invoke_tool(_tool_context: Any, raw_arguments: str) -> str:
        """Execute the local tool registry with SDK-supplied JSON arguments."""

        arguments = _parse_tool_arguments(raw_arguments)
        result = registry.execute(
            str(definition["name"]),
            arguments,
            ToolExecutionContext(session_id=session_id),
        )
        return result.output

    return FunctionTool(
        name=str(definition["name"]),
        description=str(definition["description"]),
        params_json_schema=cast(dict[str, Any], definition["parameters"]),
        strict_json_schema=strict,
        needs_approval=needs_approval if definition["name"] == "run_shell" else False,
        on_invoke_tool=invoke_tool,
    )


def read_agents_sdk_text_delta(event: object) -> str | None:
    """Read streaming text deltas from raw Agents SDK model events."""

    data = _dict_content(_dict_content(event).get("data"))
    if data.get("type") in {"output_text_delta", "response.output_text.delta"}:
        delta = data.get("delta")
        return delta if isinstance(delta, str) else None
    return None


def read_agents_sdk_tool_call(event: object) -> dict[str, Any] | None:
    """Read function call starts from Agents SDK run-item events."""

    record = _dict_content(event)
    if record.get("type") != "run_item_stream_event" or record.get("name") != "tool_called":
        return None
    item = _dict_content(record.get("item"))
    raw_item = _dict_content(item.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(item)
    name = _string(raw_item.get("name")) or _string(item.get("name")) or "tool"
    return {
        "id": tool_call_id or _new_tool_call_id(),
        "name": name,
        "args": _parse_tool_arguments(raw_item.get("arguments")),
    }


def read_agents_sdk_tool_result(event: object) -> dict[str, Any] | None:
    """Read function call outputs from Agents SDK run-item events."""

    record = _dict_content(event)
    if record.get("type") != "run_item_stream_event" or record.get("name") != "tool_output":
        return None
    item = _dict_content(record.get("item"))
    raw_item = _dict_content(item.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(item)
    name = _string(raw_item.get("name")) or _string(item.get("name")) or "tool"
    output = _stringify_tool_output(item.get("output", raw_item.get("output")))
    parsed = _parse_tool_output(output)
    return {
        "id": tool_call_id or _new_tool_call_id(),
        "name": name,
        "output": output,
        "status": "approval_required"
        if parsed.get("approvalRequired") is True
        else "ok",
    }


def read_agents_sdk_approval(
    event: object, approval_state: Mapping[str, AgentsSdkApprovalMetadata]
) -> AgentsSdkApprovalMetadata | None:
    """Map SDK approval-request stream events back to durable Kodeks approvals."""

    record = _dict_content(event)
    if (
        record.get("type") != "run_item_stream_event"
        or record.get("name") != "tool_approval_requested"
    ):
        return None
    return approval_from_sdk_item(record.get("item"), approval_state)


def approval_from_sdk_item(
    item: object, approval_state: Mapping[str, AgentsSdkApprovalMetadata]
) -> AgentsSdkApprovalMetadata | None:
    """Resolve a SDK interruption item to known approval metadata or fallback ids."""

    record = _dict_content(item)
    raw_item = _dict_content(record.get("rawItem"))
    tool_call_id = _read_tool_call_id(raw_item) or _read_tool_call_id(record)
    if tool_call_id is None:
        return None
    return approval_state.get(
        tool_call_id,
        AgentsSdkApprovalMetadata(
            approval_id=tool_call_id,
            tool_call_id=tool_call_id,
            reason="Tool call requires approval",
        ),
    )


def _dict_content(value: object) -> dict[str, Any]:
    """Return dictionaries from plain mappings or pydantic-style SDK objects."""

    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(by_alias=True, exclude_none=True)
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _content_text(value: object) -> str:
    """Read text from stored transcript content."""

    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text
    return json.dumps(value, separators=(",", ":"))


def _parse_tool_arguments(value: object) -> dict[str, Any]:
    """Parse SDK tool arguments from a JSON string or mapping."""

    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_tool_output(output: str) -> dict[str, Any]:
    """Parse JSON tool output for approval status extraction."""

    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _stringify_tool_output(output: object) -> str:
    """Serialize SDK tool output to the existing UI string contract."""

    if isinstance(output, str):
        return output
    if output is None:
        return ""
    return json.dumps(output, separators=(",", ":"))


def _read_tool_call_id(item: Mapping[str, Any]) -> str | None:
    """Read tool call ids across SDK and wire-format naming variants."""

    for key in ("callId", "call_id", "id", "toolCallId"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _string(value: object) -> str | None:
    """Return non-empty strings for optional event fields."""

    return value if isinstance(value, str) and value else None


def _new_tool_call_id() -> str:
    """Generate a stable-prefix fallback tool call id."""

    return f"tool_{uuid.uuid4().hex}"


def _fallback_agent_instructions(
    mode: str,
    memory_context: Mapping[str, list[dict[str, Any]]] | None,
    active_plan: Any | None,
    selected_files: list[dict[str, Any]] | None,
) -> str:
    """Build minimal instructions when runtime does not inject full context."""

    context_counts = {
        key: len(value)
        for key, value in (memory_context or {"profiles": [], "recalledItems": []}).items()
    }
    return "\n".join(
        [
            "You are Kodeks, a local-first coding agent.",
            "Reply in the user's language.",
            "Do not reveal hidden reasoning.",
            "Use function tools for workspace facts; do not write tool-call JSON in visible text.",
            "Plan mode is read-only." if mode == "plan" else "Act mode can use workspace tools.",
            f"Selected files: {len(selected_files or [])}.",
            f"Memory context counts: {json.dumps(context_counts, separators=(',', ':'))}.",
            "Active plan is present." if active_plan is not None else "No active plan artifact.",
        ]
    )


def _reasoning_effort(value: str | None) -> ReasoningEffortValue | None:
    """Return SDK-supported reasoning effort literals only."""

    if value in {"none", "minimal", "low", "medium", "high", "xhigh"}:
        return cast(ReasoningEffortValue, value)
    return None
