"""Python chat runtime loop for Kodeks."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator, Mapping
from typing import Any

from .agents_events import (
    AgentsSdkApprovalMetadata,
    approval_from_sdk_item,
    read_agents_sdk_approval,
    read_agents_sdk_text_delta,
    read_agents_sdk_tool_call,
    read_agents_sdk_tool_result,
)
from .agents_runtime import (
    AgentsSdkRunner,
    build_agents_sdk_agent,
    create_agents_sdk_run_config,
    default_agents_sdk_runner,
    to_agents_sdk_input_items,
)
from .config import (
    ModelConfigurationError,
    load_model_runtime_env,
    resolve_model_client_options,
)
from .contracts import StoredPlanArtifact
from .plans import build_plan_artifact_content
from .responses_runtime import ResponsesEventFactory, run_responses_tool_loop
from .responses_tool_loop import (
    parse_json_object,
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
from .tools.registry import (
    build_default_tool_registry,
)
from .tools.types import ToolRegistryServices
from .workspace import WorkspaceService

MAX_TOOL_LOOP_TURNS = 12


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

        async def complete_assistant_turn(
            assistant_text: str, response_id: str
        ) -> AsyncIterator[dict[str, Any]]:
            """Persist the final assistant turn for this runtime session."""

            async for completion_event in _persist_completed_assistant_turn(
                database=database,
                session_id=session_id,
                mode=mode,
                user_input=user_input,
                assistant_text=assistant_text,
                response_id=response_id,
            ):
                yield completion_event

        async for responses_event in run_responses_tool_loop(
            body=body,
            runtime_body=runtime_body,
            database=database,
            workspace_root=workspace_root,
            runtime_env=runtime_env,
            session_id=session_id,
            registry=registry,
            complete_assistant_turn=complete_assistant_turn,
            responses_event_factory=responses_event_factory,
            max_tool_loop_turns=MAX_TOOL_LOOP_TURNS,
        ):
            yield responses_event
        return
    except ModelConfigurationError as exc:
        code = (
            "model_provider_missing"
            if str(exc).startswith(("A model provider is required.", "A DeepSeek provider is required."))
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
            "A DeepSeek provider is required. Configure KODEKS_CHAT_COMPLETIONS_* for the DeepSeek MoonBridge route."
        )
    approval_state: dict[str, AgentsSdkApprovalMetadata] = {}
    instructions = build_runtime_instructions(
        mode, active_plan, memory_context, selected_files
    )
    agent = build_agents_sdk_agent(
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
    result = (runner or default_agents_sdk_runner()).run_streamed(
        agent,
        to_agents_sdk_input_items(database.sessions.get_transcript(session_id)),
        max_turns=MAX_TOOL_LOOP_TURNS,
        run_config=run_config,
        previous_response_id=None,
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
                parsed_output = parse_json_object(str(tool_result["output"]))
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


def _use_agents_sdk_runtime(
    env: Mapping[str, str | None], body: Mapping[str, Any]
) -> bool:
    """Return whether the current model should use the OpenAI Agents SDK path."""

    if env.get("KODEKS_FORCE_AGENTS_SDK_RUNTIME") in {"1", "true", "TRUE"}:
        return True
    return False


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
