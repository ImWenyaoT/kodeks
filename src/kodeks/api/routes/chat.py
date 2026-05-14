# q1: chat route 在这个项目里负责什么？
# a1: 它只把 HTTP request 交给 runtime，并把 runtime event 序列化成 SSE；它不关心 OpenAI SDK、session 策略或 tool loop。
# q2: 为什么 route 层越薄越好？
# a2: 因为后续同一套 runtime 可能被 CLI/TUI/测试调用。HTTP 只是一个入口，不应该把业务编排锁死在 FastAPI 里。

from collections.abc import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from kodeks.runtime.chat_runtime import ChatRuntime
from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.session_state import SQLiteSessionStateStore
from kodeks.schemas.chat import ChatStreamRequest
from kodeks.services.api.openai_responses import OpenAIResponsesProvider

router = APIRouter(prefix="/api/chat", tags=["chat"])

# 进程级单例：同一个 FastAPI 进程内复用 runtime 和 SQLite store
chat_runtime = ChatRuntime(
    provider=OpenAIResponsesProvider(),
    session_store=SQLiteSessionStateStore(),
)


def to_sse(event: ChatStreamEvent) -> str:
    """Serialize a kodeks stream event as one SSE frame."""

    return f"event: {event.type}\ndata: {event.model_dump_json()}\n\n"


@router.post("/stream")
async def stream_chat(request: ChatStreamRequest) -> StreamingResponse:
    """Expose the chat runtime as an HTTP server-sent event stream."""

    async def event_generator() -> AsyncIterator[str]:
        async for event in chat_runtime.stream_chat(request):
            yield to_sse(event)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
    )
