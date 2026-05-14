# q1: 为什么要把 stream event contract 放在 runtime 层，而不是 API route 里？
# a1: 因为这些事件是 coding agent 的内部协议；HTTP/SSE、CLI、未来 TUI 都应该消费同一套事件，而不是各自发明格式。
# q2: 这个设计体现了什么技术品味？
# a2: 它把“业务语义”从“传输协议”中分离出来。route 只负责传输，runtime 负责表达 agent 正在输出文本、完成、失败或执行工具。

from typing import Literal

from pydantic import BaseModel


ChatStreamEventType = Literal[
    "session_created",
    "text_delta",
    "response_completed",
    "error",
    "tool_call",
    "tool_result",
]


class ChatStreamEvent(BaseModel):
    """Internal event contract emitted by the kodeks agent runtime."""

    type: ChatStreamEventType
    delta: str | None = None
    response_id: str | None = None
    message: str | None = None
    session_id: str | None = None
