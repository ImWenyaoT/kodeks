# q1: chat runtime 现在为什么看起来很薄？
# a1: Phase 3 只负责把模型 streaming 接入 agent event contract；先保持薄层，是为了 Phase 4 在这里加入 session state，而不是污染 API route 或 outbound API client。
# q2: 这和普通 chatbot service 有什么不同？
# a2: 普通 chatbot 往往直接 request -> model -> response；coding agent runtime 会逐步承载 session、tool loop、approval、plan mode 等工作流状态。
# q3: Phase 5A 为什么把 tool loop 放在 runtime？
# a3: 因为 tool loop 是 agent 工作流编排：模型请求工具、本地执行、回传 tool output、继续生成最终回答。provider 只翻译外部 API，route 只传输 SSE，都不应该偷偷执行本地工具。
# q4: runtime 的设计参考谁？
# a4: 编排思路优先参考 /Users/edward/Documents/src 的 tool orchestration / session 设计，再用 opencode 的 session/agent/tool 结构做第二对照；代码实现保持 provider-neutral，再由 DeepSeek chat-completions adapter 翻译外部 API。

import asyncio
import json
from collections.abc import AsyncIterator
from uuid import uuid4

from kodeks.runtime.events import ChatStreamEvent
from kodeks.runtime.provider import ChatMessage, ChatProvider, ChatProviderRequest, ToolOutput
from kodeks.runtime.session_state import InMemorySessionStateStore, SessionStateStore
from kodeks.schemas.chat import ChatStreamRequest
from kodeks.services.memory_service import InMemoryMemoryStore, JSONLMemoryStore
from kodeks.tools.registry import ToolExecutionContext, ToolRegistry, build_default_tool_registry


class ChatRuntime:
    """Coordinate one chat turn without depending on HTTP or SDK details."""

    def __init__(
        self,
        provider: ChatProvider,
        session_store: SessionStateStore | None = None,
        tool_registry: ToolRegistry | None = None,
        memory_store: InMemoryMemoryStore | JSONLMemoryStore | None = None,
    ) -> None:
        # Provider 层：只负责模型 streaming，不负责 session 状态
        self._provider = provider

        # Runtime 状态层：负责 session transcript 和兼容性的 latest completion id
        self._session_store = session_store or InMemorySessionStateStore()

        # Tool 层：Phase 5A 只暴露 read_file，后续工具从 registry 扩展
        self._tool_registry = tool_registry or build_default_tool_registry()

        # Memory 层：按当前输入召回少量长期记忆，再显式注入模型输入
        self._memory_store = memory_store or JSONLMemoryStore()

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

        # 3. 状态回填层：如果没显式传，就用 session_id 查上一轮 completion id
        if previous_response_id is None:
            previous_response_id = await self._session_store.get_previous_response_id(session_id)

        transcript = await self._session_store.get_transcript(session_id)
        await self._session_store.append_transcript_event(
            session_id,
            "user",
            request.input,
        )

        assembled_user_input = await asyncio.to_thread(
            self._assemble_user_input,
            request,
        )

        # 4. Provider 调用层：把当前模式允许的工具定义交给模型
        provider_request = ChatProviderRequest(
            user_input=assembled_user_input,
            messages=self._chat_messages(transcript, assembled_user_input),
            previous_response_id=previous_response_id,
            tools=self._tool_registry.definitions(read_only_only=request.mode == "plan"),
        )

        tool_call_events: list[ChatStreamEvent] = []
        first_response_completed: ChatStreamEvent | None = None
        first_turn_failed = False
        assistant_text_parts: list[str] = []

        async for event in self._provider.stream_response(provider_request):
            # 5. 协议增强层：所有事件都带 session_id，方便前端知道属于哪个会话
            event = event.model_copy(update={"session_id": session_id})

            if event.type == "tool_call":
                tool_call_events.append(event)
                yield event
                continue

            if event.type == "response_completed":
                first_response_completed = event
                continue

            if event.type == "text_delta" and event.delta is not None:
                assistant_text_parts.append(event.delta)

            # 7. error 不更新 store，避免把坏状态写进去
            if event.type == "error":
                first_turn_failed = True

            yield event

        if first_turn_failed:
            return

        if not tool_call_events:
            if first_response_completed is not None:
                await self._remember_assistant_text(session_id, assistant_text_parts)
                await self._remember_completed_response(session_id, first_response_completed)
                yield first_response_completed
            return

        if first_response_completed is None or first_response_completed.response_id is None:
            yield ChatStreamEvent(
                type="error",
                message="LLM requested a tool but did not provide a response_id",
                session_id=session_id,
            )
            return

        tool_outputs: list[ToolOutput] = []
        for tool_call in tool_call_events:
            tool_result = await asyncio.to_thread(
                self._tool_registry.execute,
                tool_call.tool_name or "",
                tool_call.tool_arguments or {},
                ToolExecutionContext(
                    session_id=session_id,
                    tool_call_id=tool_call.tool_call_id,
                ),
            )
            tool_result_event = ChatStreamEvent(
                type="tool_result",
                session_id=session_id,
                tool_call_id=tool_call.tool_call_id,
                tool_name=tool_call.tool_name,
                tool_output=tool_result.output,
                tool_status=tool_result.status,
            )
            yield tool_result_event
            tool_outputs.append(
                ToolOutput(
                    tool_call_id=tool_call.tool_call_id or "",
                    output=tool_result.output,
                )
            )

        follow_up_request = ChatProviderRequest(
            user_input="",
            messages=[
                *provider_request.messages,
                self._assistant_tool_calls_message(tool_call_events),
            ],
            previous_response_id=first_response_completed.response_id,
            tool_outputs=tool_outputs,
        )

        async for event in self._provider.stream_response(follow_up_request):
            event = event.model_copy(update={"session_id": session_id})

            if event.type == "text_delta" and event.delta is not None:
                assistant_text_parts.append(event.delta)

            if (
                event.type == "response_completed"
                and event.response_id
            ):
                await self._remember_assistant_text(session_id, assistant_text_parts)
                await self._remember_completed_response(session_id, event)

            yield event

    def _assemble_user_input(self, request: ChatStreamRequest) -> str:
        """Build model input from mode instruction, relevant memory, and user text."""

        sections: list[str] = []
        if request.mode == "plan":
            sections.append(
                "<plan_mode>\n"
                "You are in plan mode. Analyze, ask clarifying questions when needed, "
                "and produce a plan. Do not modify files or run shell commands.\n"
                "</plan_mode>"
            )

        memories = self._memory_store.recall(request.input, limit=5)
        if memories:
            memory_lines = [
                f"- [{memory.get('scope', 'project')}] {memory.get('content', '')}"
                for memory in memories
            ]
            sections.append(
                "<relevant_memory>\n"
                + "\n".join(memory_lines)
                + "\n</relevant_memory>"
            )

        sections.append(request.input)
        return "\n\n".join(sections)

    def _chat_messages(
        self,
        transcript: list[dict[str, str]],
        user_input: str,
    ) -> list[ChatMessage]:
        """Build chat-completions messages from stored transcript and current input."""

        messages: list[ChatMessage] = []
        for item in transcript:
            role = item.get("role")
            if role not in {"user", "assistant"}:
                continue
            messages.append(
                ChatMessage(
                    role=role,
                    content=item.get("content", ""),
                )
            )

        messages.append(ChatMessage(role="user", content=user_input))
        return messages

    def _assistant_tool_calls_message(
        self,
        tool_call_events: list[ChatStreamEvent],
    ) -> ChatMessage:
        """Build the assistant tool_calls message required by chat completions."""

        tool_calls = []
        for tool_call in tool_call_events:
            tool_arguments = tool_call.tool_arguments or {}
            tool_calls.append(
                {
                    "id": tool_call.tool_call_id or "",
                    "type": "function",
                    "function": {
                        "name": tool_call.tool_name or "",
                        "arguments": self._tool_arguments_json(tool_arguments),
                    },
                }
            )

        return ChatMessage(role="assistant", content=None, tool_calls=tool_calls)

    def _tool_arguments_json(self, tool_arguments: dict[str, object]) -> str:
        """Serialize tool arguments in the compact JSON shape providers expect."""

        return json.dumps(
            tool_arguments,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    async def _remember_assistant_text(
        self,
        session_id: str,
        assistant_text_parts: list[str],
    ) -> None:
        """Persist streamed assistant text in the session transcript."""

        assistant_text = "".join(assistant_text_parts)
        if not assistant_text:
            return

        await self._session_store.append_transcript_event(
            session_id,
            "assistant",
            assistant_text,
        )
        assistant_text_parts.clear()

    async def _remember_completed_response(
        self,
        session_id: str,
        event: ChatStreamEvent,
    ) -> None:
        """Persist a completed final response as the latest session state."""

        if event.response_id is None:
            return

        await self._session_store.set_previous_response_id(
            session_id,
            event.response_id,
        )
