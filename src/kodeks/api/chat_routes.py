"""FastAPI routes for chat event streams."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ..responses_runtime import ResponsesEventFactory
from ..runtime import run_python_chat_turn
from .dependencies import DatabaseProvider, JsonBodyReader, WorkspaceRootResolver
from .sse import sse_frame
from .ui_transport import to_ui_transport_payload


def register_chat_routes(
    app: FastAPI,
    *,
    read_json_body: JsonBodyReader,
    database: DatabaseProvider,
    resolve_workspace_root: WorkspaceRootResolver,
    responses_event_factory: ResponsesEventFactory | None = None,
) -> None:
    """Register raw runtime and UI transport chat streams."""

    async def chat_turn_events(body: Mapping[str, Any]) -> AsyncIterator[dict[str, Any]]:
        """Run one chat turn through the configured runtime dependencies."""

        async for event in run_python_chat_turn(
            body,
            database(),
            resolve_workspace_root(),
            os.environ,
            responses_event_factory,
        ):
            yield event

    async def runtime_sse_frames(body: Mapping[str, Any]) -> AsyncIterator[str]:
        """Stream raw Kodeks runtime events as SSE frames."""

        async for event in chat_turn_events(body):
            yield sse_frame(str(event["type"]), event)

    async def ui_sse_frames(body: Mapping[str, Any]) -> AsyncIterator[str]:
        """Stream UI-transport-adapted chat events as SSE frames."""

        async for event in chat_turn_events(body):
            payload = to_ui_transport_payload(event)
            if payload is not None:
                yield sse_frame(str(payload["type"]), payload)

    @app.post("/api/chat/stream")
    async def chat_stream(request: Request) -> StreamingResponse:
        """Run one Python chat turn and stream Kodeks runtime events."""

        body = await read_json_body(request)
        return StreamingResponse(
            runtime_sse_frames(body), media_type="text/event-stream"
        )

    @app.post("/api/chat/ui")
    async def chat_ui_stream(request: Request) -> StreamingResponse:
        """Run one Python chat turn and stream UI transport adapter events."""

        body = await read_json_body(request)
        return StreamingResponse(ui_sse_frames(body), media_type="text/event-stream")
