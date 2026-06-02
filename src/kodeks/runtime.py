"""Python chat runtime loop for the incremental Kodeks migration."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from openai import AsyncOpenAI

from .agents_runtime import (
    AgentsSdkApprovalMetadata,
    AgentsSdkRunner,
    approval_from_sdk_item,
    build_agents_sdk_build_agent,
    create_agents_sdk_run_config,
    default_agents_sdk_runner,
    read_agents_sdk_approval,
    read_agents_sdk_text_delta,
    read_agents_sdk_tool_call,
    read_agents_sdk_tool_result,
    to_agents_sdk_input_items,
)
from .bridge import (
    fetch_chat_completions_stream,
    from_deepseek_stream,
    to_deepseek_chat_request,
)
from .config import (
    ModelConfigurationError,
    load_model_runtime_env,
    read_chat_completions_api_key,
    read_chat_completions_config,
    resolve_model_client_options,
)
from .contracts import StoredPlanArtifact
from .plans import build_plan_artifact_content
from .responses_adapter import (
    build_openai_responses_payload as _build_openai_responses_payload,
)
from .responses_adapter import (
    normalize_responses_event_stream as _normalize_responses_event_stream,
)
from .runtime_context import (
    body_with_runtime_context,
    build_memory_context,
    build_runtime_instructions,
    memory_context_ids,
    memory_context_layer_counts,
    selected_files_from_body,
)
from .storage import KodeksDatabase
from .tools import (
    ToolExecutionContext,
    ToolRegistryServices,
    build_default_tool_registry,
    default_tool_definitions,
)
from .transcript_replay import (
    build_responses_input_from_transcript as _build_responses_input_from_transcript,
)
from .ui_transport import to_ui_transport_payload as _to_ui_transport_payload
from .workspace import WorkspaceService

to_ui_transport_payload = _to_ui_transport_payload
build_openai_responses_payload = _build_openai_responses_payload
normalize_responses_event_stream = _normalize_responses_event_stream
build_responses_input_from_transcript = _build_responses_input_from_transcript

ResponsesEventStream = AsyncIterator[dict[str, Any]] | Iterable[dict[str, Any]]
ResponsesEventFactory = Callable[
    [Mapping[str, Any], Mapping[str, str | None]], ResponsesEventStream
]
MAX_TOOL_LOOP_TURNS = 12


@dataclass
class ToolRoundState:
    """Track tool calls that decide whether the current model turn continues."""

    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_messages: list[dict[str, str]] = field(default_factory=list)
    reasoning_content: str | None = None
    waiting_for_approval: bool = False
    halt_tool_loop: bool = False


async def run_python_chat_turn(
    body: Mapping[str, Any],
    database: KodeksDatabase,
    workspace_root: str,
    env: Mapping[str, str | None] | None = None,
    responses_event_factory: ResponsesEventFactory | None = None,
    agents_runner: AgentsSdkRunner | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Run one Python chat turn and emit the Kodeks SSE event contract."""

    runtime_env = os.environ if env is None else env
    user_input = _string(body.get("input"))
    requested_session_id = _string(body.get("session_id"))
    if user_input is None:
        yield _error_event("Input is required.", requested_session_id or "")
        return

    mode = "plan" if body.get("mode") == "plan" else "act"
    session = _ensure_session(database, requested_session_id, mode, workspace_root)
    session_id = session.id
    database.sessions.append_message(session_id, "user", user_input)
    yield {"type": "session_created", "session_id": session_id}

    active_plan = database.plans.get_active_by_session(session_id)
    if active_plan is not None:
        yield {
            "type": "plan_artifact",
            "action": "recovered",
            "plan": active_plan.model_dump(by_alias=True),
            "session_id": session_id,
        }
    memory_context = build_memory_context(database, user_input)
    memory_ids = memory_context_ids(memory_context)
    if memory_ids:
        yield {
            "type": "memory_recalled",
            "memory_ids": memory_ids,
            "memory_layers": memory_context_layer_counts(memory_context),
            "session_id": session_id,
        }

    workspace = WorkspaceService(workspace_root)
    registry = build_default_tool_registry(
        ToolRegistryServices(workspace, database, runtime_env)
    )
    selected_files = selected_files_from_body(body)
    runtime_body = body_with_runtime_context(
        body, mode, active_plan, memory_context, selected_files
    )
    if runtime_env.get("KODEKS_RESPONSES_STATEFUL") == "true":
        previous_response_id = database.sessions.get_latest_assistant_response_id(
            session_id
        )
        if previous_response_id is not None:
            runtime_body["previous_response_id"] = previous_response_id

    try:
        if responses_event_factory is None and _use_agents_sdk_runtime(
            runtime_env, body
        ):
            async for agents_event in _run_agents_sdk_chat_turn(
                body=body,
                database=database,
                workspace_root=workspace_root,
                runtime_env=runtime_env,
                session_id=session_id,
                mode=mode,
                user_input=user_input,
                active_plan=active_plan,
                memory_context=memory_context,
                selected_files=selected_files,
                registry=registry,
                runner=agents_runner,
            ):
                yield agents_event
            return

        for _turn_index in range(MAX_TOOL_LOOP_TURNS):
            runtime_body["input"] = build_responses_input_from_transcript(
                database, session_id
            )
            responses_events = (
                responses_event_factory(runtime_body, runtime_env)
                if responses_event_factory is not None
                else _live_responses_events(runtime_body, runtime_env)
            )
            assistant_text = ""
            completed = False
            tool_state = ToolRoundState()
            async for event in _aiter(responses_events):
                event_type = event.get("type")
                if event_type == "response.output_text.delta":
                    delta = str(event.get("delta") or "")
                    if delta:
                        assistant_text += delta
                        yield {
                            "type": "text_delta",
                            "delta": delta,
                            "session_id": session_id,
                        }
                    continue

                if event_type == "response.output_item.done":
                    async for tool_event in _handle_output_item(
                        event.get("item"),
                        registry,
                        database,
                        workspace_root,
                        runtime_env,
                        session_id,
                        tool_state,
                    ):
                        yield tool_event
                    continue

                if event_type == "response.failed":
                    yield _error_event(
                        _response_error_message(event),
                        session_id,
                        "moonbridge_upstream_failed",
                    )
                    return

                if event_type == "error":
                    yield _error_event(_stream_error_message(event), session_id)
                    return

                if event_type == "response.completed":
                    completed = True
                    if (
                        tool_state.tool_messages
                        or tool_state.waiting_for_approval
                        or tool_state.halt_tool_loop
                    ):
                        break
                    response = event.get("response")
                    response_id = (
                        str(response.get("id"))
                        if isinstance(response, dict) and response.get("id") is not None
                        else "resp_python"
                    )
                    async for completion_event in _persist_completed_assistant_turn(
                        database=database,
                        session_id=session_id,
                        mode=mode,
                        user_input=user_input,
                        assistant_text=assistant_text,
                        response_id=response_id,
                    ):
                        yield completion_event
                    return

            if tool_state.halt_tool_loop:
                return
            if tool_state.waiting_for_approval:
                return
            if tool_state.tool_messages:
                _append_tool_continuation_messages(
                    database=database,
                    session_id=session_id,
                    assistant_text=assistant_text,
                    reasoning_content=tool_state.reasoning_content,
                    tool_calls=tool_state.tool_calls,
                    tool_messages=tool_state.tool_messages,
                )
                continue
            if not completed:
                yield _error_event("Model stream ended before completion.", session_id)
                return
            return

        yield _error_event("Model tool loop exceeded the maximum turn limit.", session_id)
        return
    except ModelConfigurationError as exc:
        code = (
            "model_provider_missing"
            if str(exc).startswith("A model provider is required.")
            else exc.code
        )
        yield _error_event(str(exc), session_id, code)
        return
    except Exception as exc:
        yield _error_event(str(exc), session_id, "runtime_error")
        return


async def _run_agents_sdk_chat_turn(
    *,
    body: Mapping[str, Any],
    database: KodeksDatabase,
    workspace_root: str,
    runtime_env: Mapping[str, str | None],
    session_id: str,
    mode: str,
    user_input: str,
    active_plan: StoredPlanArtifact | None,
    memory_context: Mapping[str, list[dict[str, Any]]],
    selected_files: list[dict[str, Any]],
    registry: Any,
    runner: AgentsSdkRunner | None,
) -> AsyncIterator[dict[str, Any]]:
    """Run one default Python OpenAI Agents SDK chat turn."""

    model_env = load_model_runtime_env(runtime_env, body.get("model"))
    model_options = resolve_model_client_options(
        model_env, body.get("reasoning_effort"), body.get("provider")
    )
    if model_options is None:
        raise ModelConfigurationError(
            "A model provider is required. Configure KODEKS_CHAT_COMPLETIONS_* for DeepSeek-first MoonBridge, or configure KODEKS_RESPONSES_* / OPENAI_* for OpenAI fallback."
        )
    approval_state: dict[str, AgentsSdkApprovalMetadata] = {}
    instructions = build_runtime_instructions(
        mode, active_plan, memory_context, selected_files
    )
    agent = build_agents_sdk_build_agent(
        database=database,
        workspace_root=workspace_root,
        mode=mode,
        model=str(model_options["model"]),
        environment=model_env,
        session_id=session_id,
        memory_context=memory_context,
        active_plan=active_plan,
        selected_files=selected_files,
        instructions=instructions,
        registry=registry,
        approval_state=approval_state,
    )
    run_config = create_agents_sdk_run_config(
        api_key=str(model_options["apiKey"]),
        base_url=str(model_options["baseURL"])
        if isinstance(model_options.get("baseURL"), str)
        else None,
        reasoning_effort=str(model_options.get("reasoningEffort") or "medium"),
    )
    previous_response_id = (
        database.sessions.get_latest_assistant_response_id(session_id)
        if model_options.get("provider") == "openai"
        and model_options.get("statefulResponses") is True
        else None
    )
    result = (runner or default_agents_sdk_runner()).run_streamed(
        agent,
        to_agents_sdk_input_items(database.sessions.get_transcript(session_id)),
        max_turns=MAX_TOOL_LOOP_TURNS,
        run_config=run_config,
        previous_response_id=previous_response_id,
    )
    assistant_text = ""
    waiting_for_approval = False

    async for sdk_event in result.stream_events():
        text_delta = read_agents_sdk_text_delta(sdk_event)
        if text_delta is not None:
            assistant_text += text_delta
            yield {
                "type": "text_delta",
                "delta": text_delta,
                "session_id": session_id,
            }
            continue

        tool_call = read_agents_sdk_tool_call(sdk_event)
        if tool_call is not None:
            yield {
                "type": "assistant_status",
                "message": f"Using {tool_call['name']}",
                "session_id": session_id,
            }
            yield {
                "type": "tool_call",
                "tool_call_id": str(tool_call["id"]),
                "tool_name": str(tool_call["name"]),
                "tool_arguments": tool_call["args"],
                "session_id": session_id,
            }
            continue

        tool_result = read_agents_sdk_tool_result(sdk_event)
        if tool_result is not None:
            yield {
                "type": "tool_result",
                "tool_call_id": str(tool_result["id"]),
                "tool_name": str(tool_result["name"]),
                "tool_status": str(tool_result["status"]),
                "tool_output": str(tool_result["output"]),
                "session_id": session_id,
            }
            if tool_result["status"] == "approval_required":
                parsed_output = _parse_json_object(str(tool_result["output"]))
                waiting_for_approval = True
                yield {
                    "type": "approval_required",
                    "approval_id": str(parsed_output.get("approvalId") or ""),
                    "tool_call_id": str(tool_result["id"]),
                    "message": str(
                        parsed_output.get("reason") or "Command requires approval"
                    ),
                    "session_id": session_id,
                }
            continue

        approval = read_agents_sdk_approval(sdk_event, approval_state)
        if approval is not None:
            waiting_for_approval = True
            yield _agents_sdk_approval_event(approval, session_id)

    for interruption in getattr(result, "interruptions", []):
        approval = approval_from_sdk_item(interruption, approval_state)
        if approval is not None:
            waiting_for_approval = True
            yield _agents_sdk_approval_event(approval, session_id)

    if waiting_for_approval:
        return

    final_text = assistant_text or _stringify_final_output(
        getattr(result, "final_output", None)
    )
    response_id = (
        getattr(result, "last_response_id", None)
        or f"agents_{uuid.uuid4().hex}"
    )
    async for completion_event in _persist_completed_assistant_turn(
        database=database,
        session_id=session_id,
        mode=mode,
        user_input=user_input,
        assistant_text=final_text,
        response_id=str(response_id),
    ):
        yield completion_event


async def _live_responses_events(
    body: Mapping[str, Any], runtime_env: Mapping[str, str | None]
) -> AsyncIterator[dict[str, Any]]:
    """Create live Responses-shaped events from configured model routing."""

    model_env = load_model_runtime_env(runtime_env, body.get("model"))
    model_options = resolve_model_client_options(
        model_env, body.get("reasoning_effort"), body.get("provider")
    )
    if model_options is None:
        raise ModelConfigurationError(
            "A model provider is required. Configure KODEKS_CHAT_COMPLETIONS_* for DeepSeek-first MoonBridge, or configure KODEKS_RESPONSES_* / OPENAI_* for OpenAI fallback."
        )
    if model_options["provider"] == "openai":
        async for event in _openai_responses_events(body, model_options):
            yield event
        return
    if model_options["provider"] != "moonbridge":
        raise ModelConfigurationError("Unsupported model provider.")

    upstream = read_chat_completions_config(model_env)
    if upstream["missing"]:
        missing = cast(list[str], upstream["missing"])
        raise ModelConfigurationError(
            f"Missing upstream Chat Completions configuration: {', '.join(missing)}."
        )
    api_key = read_chat_completions_api_key(model_env)
    if api_key is None:
        raise ModelConfigurationError("KODEKS_CHAT_COMPLETIONS_API_KEY is required.")

    request = {
        "model": body.get("model") or model_options["model"],
        "input": body.get("input") or "",
        "instructions": body.get("instructions") or "",
        "tools": default_tool_definitions(body.get("mode") == "plan"),
        "reasoning": {"effort": body.get("reasoning_effort") or "high"},
        "stream": True,
    }
    payload = to_deepseek_chat_request(request, str(upstream["model"]))
    async for event in from_deepseek_stream(
        fetch_chat_completions_stream(payload, api_key, model_env),
        model=str(request["model"]),
    ):
        yield event


async def _openai_responses_events(
    body: Mapping[str, Any], model_options: Mapping[str, Any]
) -> AsyncIterator[dict[str, Any]]:
    """Stream direct Responses API events through the OpenAI Python SDK."""

    client = AsyncOpenAI(
        api_key=str(model_options["apiKey"]),
        base_url=str(model_options["baseURL"])
        if isinstance(model_options.get("baseURL"), str)
        else None,
    )
    payload = build_openai_responses_payload(body, model_options)
    stream = await client.responses.create(**payload)
    async for event in normalize_responses_event_stream(stream):
        yield event


async def _persist_completed_assistant_turn(
    database: KodeksDatabase,
    session_id: str,
    mode: str,
    user_input: str,
    assistant_text: str,
    response_id: str,
) -> AsyncIterator[dict[str, Any]]:
    """Persist a final assistant turn and emit plan/completion events."""

    if assistant_text:
        assistant_message = database.sessions.append_message(
            session_id,
            "assistant",
            assistant_text,
            {"responseId": response_id},
        )
        if mode == "plan":
            plan = database.plans.upsert_active(
                session_id=session_id,
                source_message_id=assistant_message.id,
                **build_plan_artifact_content(user_input, assistant_text),
            )
            yield {
                "type": "plan_artifact",
                "action": "created",
                "plan": plan.model_dump(by_alias=True),
                "session_id": session_id,
            }
    yield {
        "type": "response_completed",
        "response_id": response_id,
        "session_id": session_id,
    }


def _artifact_threshold_bytes(env: Mapping[str, str | None]) -> int:
    """Read the memory artifact threshold for large tool outputs."""

    raw = env.get("KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES")
    if raw is None:
        return 4096
    try:
        value = int(raw)
    except ValueError:
        return 4096
    return max(1, value)


async def _handle_output_item(
    item: object,
    registry: Any,
    database: KodeksDatabase,
    workspace_root: str,
    runtime_env: Mapping[str, str | None],
    session_id: str,
    tool_state: ToolRoundState,
) -> AsyncIterator[dict[str, Any]]:
    """Execute completed Responses function_call items through local tools."""

    if not isinstance(item, dict) or item.get("type") != "function_call":
        return
    tool_call_id = str(item.get("call_id") or item.get("id") or "")
    tool_name = str(item.get("name") or "")
    tool_arguments = _parse_tool_arguments(item.get("arguments"))
    yield {
        "type": "assistant_status",
        "message": f"Using {tool_name}",
        "session_id": session_id,
    }
    yield {
        "type": "tool_call",
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "tool_arguments": tool_arguments,
        "session_id": session_id,
    }
    if not registry.has(tool_name):
        output = f"Unknown tool requested by model: {tool_name}"
        tool_state.halt_tool_loop = True
        yield {
            "type": "tool_result",
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "tool_status": "error",
            "tool_output": output,
            "session_id": session_id,
        }
        yield _error_event(output, session_id, "model_requested_unknown_tool")
        return
    result = registry.execute(
        tool_name, tool_arguments, ToolExecutionContext(session_id, tool_call_id)
    )
    mapped_status = _map_tool_status(result.status)
    tool_output = result.output
    if mapped_status == "ok":
        tool_output = database.memories.compact_tool_result(
            workspace_root=workspace_root,
            session_id=session_id,
            tool_call_id=tool_call_id or None,
            tool_name=tool_name,
            output=result.output,
            threshold_bytes=_artifact_threshold_bytes(runtime_env),
        )
    parsed_output = _parse_json_object(tool_output)
    if isinstance(item.get("reasoning_content"), str):
        tool_state.reasoning_content = str(item["reasoning_content"])
    if mapped_status != "approval_required":
        tool_state.tool_calls.append(
            {"id": tool_call_id, "name": tool_name, "args": dict(tool_arguments)}
        )
        tool_state.tool_messages.append(
            {
                "toolCallId": tool_call_id,
                "name": tool_name,
                "output": tool_output,
            }
        )
    yield {
        "type": "tool_result",
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "tool_status": mapped_status,
        "tool_output": tool_output,
        "session_id": session_id,
    }
    if mapped_status == "approval_required":
        tool_state.waiting_for_approval = True
        yield {
            "type": "approval_required",
            "approval_id": str(parsed_output.get("approvalId") or ""),
            "tool_call_id": tool_call_id,
            "message": str(parsed_output.get("reason") or "Command requires approval"),
            "session_id": session_id,
        }


def _append_tool_continuation_messages(
    database: KodeksDatabase,
    session_id: str,
    assistant_text: str,
    reasoning_content: str | None,
    tool_calls: list[dict[str, Any]],
    tool_messages: list[dict[str, str]],
) -> None:
    """Persist assistant tool-call and tool output messages for continuation."""

    assistant_content: dict[str, Any] = {
        "text": assistant_text,
        "toolCalls": tool_calls,
    }
    if reasoning_content:
        assistant_content["reasoningContent"] = reasoning_content
    database.sessions.append_message(session_id, "assistant", assistant_content)
    for message in tool_messages:
        database.sessions.append_message(
            session_id,
            "tool",
            {
                "text": message["output"],
                "toolCallId": message["toolCallId"],
                "name": message["name"],
            },
        )


def _ensure_session(
    database: KodeksDatabase,
    requested_session_id: str | None,
    mode: str,
    workspace_root: str,
) -> Any:
    if requested_session_id:
        existing = database.sessions.get_session(requested_session_id)
        if existing is not None:
            database.sessions.update_mode(requested_session_id, mode)
            return database.sessions.get_session(requested_session_id) or existing
    return database.sessions.create_session(
        title="Kodeks session",
        mode=mode,
        workspace_root=workspace_root,
        session_id=requested_session_id,
    )


def _parse_tool_arguments(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _parse_json_object(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _map_tool_status(status: str) -> str:
    if status == "completed":
        return "ok"
    if status == "approval_required":
        return "approval_required"
    return "error"


def _response_error_message(event: Mapping[str, Any]) -> str:
    response = event.get("response")
    if isinstance(response, dict):
        error = response.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return str(error["message"])
    return "Model stream failed."


def _stream_error_message(event: Mapping[str, Any]) -> str:
    """Read the user-visible message from a Responses error stream event."""

    message = event.get("message")
    return str(message) if isinstance(message, str) and message else "Model stream failed."


def _use_agents_sdk_runtime(
    env: Mapping[str, str | None], body: Mapping[str, Any]
) -> bool:
    """Return whether the current model should use the OpenAI Agents SDK path."""

    if env.get("KODEKS_DIRECT_RESPONSES_RUNTIME") in {"1", "true", "TRUE"}:
        return False
    model_env = load_model_runtime_env(env, body.get("model"))
    model_options = resolve_model_client_options(
        model_env, body.get("reasoning_effort"), body.get("provider")
    )
    return model_options is not None and model_options["provider"] == "openai"


def _agents_sdk_approval_event(
    approval: AgentsSdkApprovalMetadata, session_id: str
) -> dict[str, Any]:
    """Map one SDK approval interruption into the Python runtime event contract."""

    return {
        "type": "approval_required",
        "approval_id": approval.approval_id,
        "tool_call_id": approval.tool_call_id,
        "message": approval.reason,
        "session_id": session_id,
    }


def _stringify_final_output(output: object) -> str:
    """Serialize Agents SDK final output when no text deltas were streamed."""

    if isinstance(output, str):
        return output
    if output is None:
        return ""
    return json.dumps(output, separators=(",", ":"))


def _error_event(
    message: str, session_id: str, code: str = "runtime_error"
) -> dict[str, Any]:
    return {
        "type": "error",
        "message": message,
        "code": code,
        "session_id": session_id,
    }


def _string(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


async def _aiter(stream: ResponsesEventStream) -> AsyncIterator[dict[str, Any]]:
    if isinstance(stream, Iterable):
        for item in stream:
            yield item
        return
    async for item in stream:
        yield item


def default_workspace_root() -> str:
    """Return the default workspace root for runtime tests and routes."""

    return str(Path.cwd().resolve())
