"""Python chat runtime loop for Kodeks."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping
from typing import Any

from .config import (
    ModelConfigurationError,
)
from .harness import select_harness_pattern
from .plans import build_plan_artifact_content
from .responses_runtime import ResponsesEventFactory, run_responses_tool_loop
from .runtime_context import (
    body_with_runtime_context,
    build_memory_context,
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
) -> AsyncIterator[dict[str, Any]]:
    """Run one Python chat turn and emit the Kodeks SSE event contract."""

    runtime_env = os.environ if env is None else env
    user_input = _string(body.get("input"))
    requested_session_id = _string(body.get("session_id"))
    if user_input is None:
        yield _error_event("Input is required.", requested_session_id or "")
        return

    mode = "plan" if body.get("mode") == "plan" else "act"
    parent_session_id = _parent_session_id(body)
    session = _ensure_session(
        database, requested_session_id, mode, workspace_root, parent_session_id
    )
    session_id = session.id
    database.sessions.append_message(session_id, "user", user_input)
    database.audit_log.record(
        session_id,
        "turn_started",
        {"mode": mode, "resumed": requested_session_id is not None},
    )
    harness_decision = select_harness_pattern(user_input, mode)
    database.audit_log.record(
        session_id,
        "harness_pattern_selected",
        harness_decision.to_payload(),
    )
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
        database.audit_log.record(
            session_id,
            "memory_recalled",
            {
                "memoryIds": memory_ids,
                "layers": memory_context_layer_counts(memory_context),
            },
        )

    workspace = WorkspaceService(workspace_root)
    registry = build_default_tool_registry(
        ToolRegistryServices(workspace, database, runtime_env)
    )
    selected_files = selected_files_from_body(body)
    runtime_body = body_with_runtime_context(
        body, mode, active_plan, memory_context, selected_files, harness_decision
    )
    try:
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
            database.audit_log.record(
                session_id,
                "plan_checkpointed",
                {"planId": plan.id, "sourceMessageId": assistant_message.id},
            )
    database.audit_log.record(
        session_id,
        "turn_completed",
        {"responseId": response_id, "assistantBytes": len(assistant_text.encode())},
    )
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
    parent_session_id: str | None = None,
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
        parent_session_id=parent_session_id,
    )


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


def _parent_session_id(body: Mapping[str, Any]) -> str | None:
    """Read an optional parent session id for lightweight session forks."""

    return _string(body.get("parentSessionId")) or _string(body.get("parent_session_id"))
