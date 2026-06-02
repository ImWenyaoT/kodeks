"""OpenAI Agents SDK compatibility helpers for the Python migration."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator, Iterable, Mapping
from typing import Any, Literal, Protocol, cast

from agents import Agent, FunctionTool, ModelSettings, OpenAIProvider, RunConfig, Runner
from openai.types.shared.reasoning import Reasoning

from .agents_events import (
    AgentsSdkApprovalMetadata,
    parse_tool_arguments,
)
from .contracts import StoredMessage
from .storage import KodeksDatabase
from .tools.registry import (
    ToolRegistry,
    build_default_tool_registry,
)
from .tools.schemas import ToolDefinition
from .tools.types import (
    ToolExecutionContext,
    ToolRegistryServices,
)
from .workspace import WorkspaceService, is_dangerous_command

ReasoningEffortValue = Literal["none", "minimal", "low", "medium", "high", "xhigh"]


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

        arguments = parse_tool_arguments(raw_arguments)
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


def _content_text(value: object) -> str:
    """Read text from stored transcript content."""

    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text
    return json.dumps(value, separators=(",", ":"))

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
