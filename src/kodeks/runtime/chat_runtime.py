# q1: chat runtime 现在为什么看起来很薄？
# a1: Phase 3 只负责把模型 streaming 接入 agent event contract；先保持薄层，是为了 Phase 4 在这里加入 session state，而不是污染 API route 或 outbound API client。
# q2: 这和普通 chatbot service 有什么不同？
# a2: 普通 chatbot 往往直接 request -> model -> response；coding agent runtime 会逐步承载 session、tool loop、approval、plan mode 等工作流状态。

from collections.abc import AsyncIterator
from typing import Protocol
from uuid import uuid4

from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.session_state import InMemorySessionStateStore, SessionStateStore
from kodeks.schemas.chat import ChatStreamRequest


class ChatProvider(Protocol):
    """Provider interface required by the chat runtime."""

    def stream_response(
        self,
        user_input: str,
        previous_response_id: str | None = None,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Stream one model turn as kodeks runtime events."""


class ChatRuntime:
    """Coordinate one chat turn without depending on HTTP or SDK details."""

    def __init__(
        self,
        provider: ChatProvider,
        session_store: SessionStateStore | None = None,
    ) -> None:
        # Provider 层：只负责模型 streaming，不负责 session 状态
        self._provider = provider

        # Runtime 状态层：负责 session_id -> previous_response_id
        self._session_store = session_store or InMemorySessionStateStore()

    async def stream_chat(
        self,
        request: ChatStreamRequest,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Run one chat turn through the configured provider."""

        # 1. 会话解析层：客户端没带 session_id 时，runtime 创建一个新会话
        session_id = request.session_id or f"sess_{uuid4().hex}"

        if request.session_id is None:
            yield ChatStreamEvent(
                type="session_created",
                session_id=session_id,
            )

        # 2. 状态解析层：显式 previous_response_id 优先
        previous_response_id = request.previous_response_id

        # 3. 状态回填层：如果没显式传，就用 session_id 查上一轮 response_id
        if previous_response_id is None:
            previous_response_id = self._session_store.get_previous_response_id(session_id)

        # 4. Provider 调用层：runtime 把 resolved previous_response_id 交给 provider
        async for event in self._provider.stream_response(
            user_input=request.input,
            previous_response_id=previous_response_id,
        ):
            # 5. 协议增强层：所有事件都带 session_id，方便前端知道属于哪个会话
            event.session_id = session_id

            # 6. 状态更新层：只有 response_completed 才写回最新 response_id
            if (
                event.type == "response_completed"
                and event.response_id
            ):
                self._session_store.set_previous_response_id(
                    session_id,
                    event.response_id,
                )

            # 7. error 不更新 store，避免把坏状态写进去
            yield event
