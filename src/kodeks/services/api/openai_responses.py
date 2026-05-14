# q1: 为什么 OpenAI Responses API 放在 services/api，而不是 runtime 或 api/routes？
# a1: 这里的 api 是 outbound API client，和 Claude Code 的 services/api 类似；它负责调用外部模型服务，不负责 FastAPI 入站路由。
# q2: 面试里怎么解释这层？
# a2: 这是 anti-corruption layer。它把外部 API 形状翻译成项目内部协议，后续换 provider 或接本地模型时，不需要重写 HTTP route 和 agent runtime。

import os
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from kodeks.runtime.events import ChatStreamEvent


class OpenAIResponsesProvider:
    """Translate OpenAI Responses API streams into kodeks runtime events."""

    async def stream_response(
        self,
        user_input: str,
        previous_response_id: str | None = None,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Stream one Responses API turn as kodeks runtime events."""

        api_key = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        base_url = os.getenv("LLM_BASE_URL") or os.getenv("OPENAI_BASE_URL")
        model = os.getenv("LLM_MODEL", "gpt-5.4-mini")

        if not api_key:
            yield ChatStreamEvent(
                type="error",
                message="LLM_API_KEY or OPENAI_API_KEY is not set",
            )
            return

        try:
            client = AsyncOpenAI(api_key=api_key, base_url=base_url)
            kwargs = {
                "model": model,
                "input": user_input,
                "stream": True,
            }

            if previous_response_id:
                kwargs["previous_response_id"] = previous_response_id

            stream = await client.responses.create(**kwargs)
            event_count = 0
            terminal_event_seen = False

            async for event in stream:
                event_count += 1

                if event.type == "response.output_text.delta":
                    yield ChatStreamEvent(
                        type="text_delta",
                        delta=event.delta,
                    )

                elif event.type == "response.completed":
                    terminal_event_seen = True
                    yield ChatStreamEvent(
                        type="response_completed",
                        response_id=event.response.id,
                    )

                elif event.type in {"response.failed", "response.incomplete", "error"}:
                    terminal_event_seen = True
                    yield ChatStreamEvent(
                        type="error",
                        message=self._error_message(event),
                    )

            if event_count == 0:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without events",
                )
            elif not terminal_event_seen:
                yield ChatStreamEvent(
                    type="error",
                    message="LLM stream ended without a terminal event",
                )

        except Exception as exc:
            yield ChatStreamEvent(
                type="error",
                message=str(exc),
            )

    def _error_message(self, event: object) -> str:
        """Extract a useful provider error without exposing SDK event classes."""

        response = getattr(event, "response", None)
        response_id = getattr(response, "id", None)
        incomplete_details = getattr(response, "incomplete_details", None)
        error = getattr(event, "error", None) or getattr(response, "error", None)
        message = getattr(error, "message", None) if error is not None else None

        if message:
            return message
        if incomplete_details:
            return f"LLM response incomplete: {incomplete_details}"
        if response_id:
            return f"LLM response did not complete: {response_id}"
        return "LLM response failed"
