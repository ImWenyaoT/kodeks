# q1: 为什么要把 provider request 单独建模？
# a1: coding agent 不是永远只有 user_input；工具循环还需要 messages、tools、tool_outputs 等上下文。单独建模能避免 provider interface 被字符串参数绑死。
# q2: 这层和 DeepSeek chat-completions tools 有什么关系？
# a2: 这是 kodeks 自己的 provider contract；DeepSeek adapter 负责把它翻译成 chat-completions 参数，runtime 不直接依赖外部 SDK 形状。
# q3: 为什么不直接照搬 DeepSeek/OpenAI 或 opencode 的 request 类型？
# a3: kodeks 需要自己的 provider-neutral contract。API 细节按 DeepSeek 的 OpenAI-compatible SDK 落地；抽象边界优先参考 /src 的分层，再用 opencode/packages/llm 的 provider/tool 类型做结构对照。

from collections.abc import AsyncIterator
from typing import Any, Literal, Protocol

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


class ChatMessage(BaseModel):
    """Describe one provider-neutral chat-completions message."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[dict[str, Any]] | None = None


class ChatProviderRequest(BaseModel):
    """Provider-neutral request for one model streaming turn."""

    user_input: str = ""
    messages: list[ChatMessage] = Field(default_factory=list)
    # Backward-compatible completion id for clients that still display or pass it.
    # DeepSeek context recovery is driven by messages, not this field.
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
