# q1: 为什么要把 provider request 单独建模？
# a1: coding agent 不是永远只有 user_input；工具循环还需要 tools、tool_outputs、previous_response_id 等上下文。单独建模能避免 provider interface 被字符串参数绑死。
# q2: 这层和 OpenAI Responses API 的 tools 有什么关系？
# a2: 这是 kodeks 自己的 provider contract；OpenAI adapter 负责把它翻译成 Responses API 参数，runtime 不直接依赖外部 SDK 形状。

from collections.abc import AsyncIterator
from typing import Any, Protocol

from pydantic import BaseModel, Field

from kodeks.runtime.events import ChatStreamEvent


class ToolDefinition(BaseModel):
    """Describe one model-callable tool in provider-neutral form."""

    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    strict: bool = True


class ToolOutput(BaseModel):
    """Describe one completed local tool call result."""

    tool_call_id: str
    output: str


class ChatProviderRequest(BaseModel):
    """Provider-neutral request for one model streaming turn."""

    user_input: str
    previous_response_id: str | None = None
    tools: list[ToolDefinition] = Field(default_factory=list)
    tool_outputs: list[ToolOutput] = Field(default_factory=list)


class ChatProvider(Protocol):
    """Provider interface required by the chat runtime."""

    def stream_response(
        self,
        request: ChatProviderRequest,
    ) -> AsyncIterator[ChatStreamEvent]:
        """Stream one model turn as kodeks runtime events."""
