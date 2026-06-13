"""Responses-shaped stream loop for Kodeks chat turns."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from typing import Any, cast

from .config import (
    ModelConfigurationError,
    load_model_runtime_env,
    read_chat_completions_api_key,
    read_chat_completions_config,
    resolve_model_client_options,
)
from .conversation_state import build_responses_input_from_transcript
from .providers.bridge import (
    fetch_chat_completions_stream,
    from_deepseek_stream,
    to_deepseek_chat_request,
)
from .responses_tool_loop import (
    ToolRegistryLike,
    ToolRoundState,
    append_tool_continuation_messages,
    handle_output_item,
)
from .storage import KodeksDatabase
from .tools.schemas import default_tool_definitions

ResponsesEventStream = AsyncIterator[dict[str, Any]] | Iterable[dict[str, Any]]
ResponsesEventFactory = Callable[
    [Mapping[str, Any], Mapping[str, str | None]], ResponsesEventStream
]
CompletionEventFactory = Callable[[str, str], AsyncIterator[dict[str, Any]]]


async def run_responses_tool_loop(
    *,
    body: Mapping[str, Any],
    runtime_body: dict[str, Any],
    database: KodeksDatabase,
    workspace_root: str,
    runtime_env: Mapping[str, str | None],
    session_id: str,
    registry: ToolRegistryLike,
    complete_assistant_turn: CompletionEventFactory,
    responses_event_factory: ResponsesEventFactory | None,
    max_tool_loop_turns: int,
) -> AsyncIterator[dict[str, Any]]:
    """Run Responses-shaped model events through local tool continuation."""

    for _turn_index in range(max_tool_loop_turns):
        runtime_body["input"] = build_responses_input_from_transcript(
            database, session_id
        )
        responses_events = (
            responses_event_factory(runtime_body, runtime_env)
            if responses_event_factory is not None
            else live_responses_events(runtime_body, runtime_env)
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
                async for tool_event in handle_output_item(
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
                if _looks_like_pseudo_tool_call(assistant_text):
                    yield _error_event(
                        (
                            "Model returned tool-call text instead of a native "
                            "function_call event."
                        ),
                        session_id,
                        "model_returned_pseudo_tool_call",
                    )
                    return
                response = event.get("response")
                response_id = (
                    str(response.get("id"))
                    if isinstance(response, dict) and response.get("id") is not None
                    else "resp_python"
                )
                async for completion_event in complete_assistant_turn(
                    assistant_text, response_id
                ):
                    yield completion_event
                return

        if tool_state.halt_tool_loop:
            return
        if tool_state.waiting_for_approval:
            return
        if tool_state.tool_messages:
            append_tool_continuation_messages(
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


async def live_responses_events(
    body: Mapping[str, Any], runtime_env: Mapping[str, str | None]
) -> AsyncIterator[dict[str, Any]]:
    """Create live Responses-shaped events from configured model routing."""

    model_env = load_model_runtime_env(runtime_env, body.get("model"))
    model_options = resolve_model_client_options(
        model_env, body.get("reasoning_effort"), body.get("provider")
    )
    if model_options is None:
        raise ModelConfigurationError(
            "An OpenAI-compatible Chat Completions provider is required. Set API_KEY or DEEPSEEK_API_KEY for the MoonBridge route."
        )
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
        raise ModelConfigurationError("API_KEY or DEEPSEEK_API_KEY is required.")

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


def _response_error_message(event: Mapping[str, Any]) -> str:
    """Read the user-visible message from a failed Responses event."""

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


def _looks_like_pseudo_tool_call(text: str) -> bool:
    """Return whether visible text contains a fake serialized tool call."""

    lowered = text.lower()
    return "<tool_call" in lowered or 'type="tool_calls"' in lowered


def _error_event(
    message: str, session_id: str, code: str = "runtime_error"
) -> dict[str, Any]:
    """Build one runtime error event."""

    return {
        "type": "error",
        "message": message,
        "code": code,
        "session_id": session_id,
    }


async def _aiter(stream: ResponsesEventStream) -> AsyncIterator[dict[str, Any]]:
    """Iterate over sync or async Responses event streams."""

    if isinstance(stream, Iterable):
        for item in stream:
            yield item
        return
    async for item in stream:
        yield item
