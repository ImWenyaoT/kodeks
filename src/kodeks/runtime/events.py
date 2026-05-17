# q1: 为什么要把 stream event contract 放在 runtime 层，而不是 API route 里？
# a1: 因为这些事件是 coding agent 的内部协议；HTTP/SSE、CLI、未来 TUI 都应该消费同一套事件，而不是各自发明格式。
# q2: 这个设计体现了什么技术品味？
# a2: 它把“业务语义”从“传输协议”中分离出来。route 只负责传输，runtime 负责表达 agent 正在输出文本、完成、失败或执行工具。

from typing import Any, Literal

from pydantic import BaseModel, model_validator


ChatStreamEventType = Literal[
    "session_created",
    "text_delta",
    "response_completed",
    "error",
    "tool_call",
    "tool_result",
]

ToolResultStatus = Literal["completed", "failed"]


class ChatStreamEvent(BaseModel):
    """Internal event contract emitted by the kodeks agent runtime."""

    type: ChatStreamEventType
    delta: str | None = None
    response_id: str | None = None
    message: str | None = None
    session_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, Any] | None = None
    tool_output: str | None = None
    tool_status: ToolResultStatus | None = None

    @model_validator(mode="after")
    def validate_event_shape(self) -> "ChatStreamEvent":
        """Ensure each event type carries the fields the runtime needs."""

        if self.type == "session_created" and self.session_id is None:
            raise ValueError("session_created event requires session_id")

        if self.type == "text_delta" and self.delta is None:
            raise ValueError("text_delta event requires delta")

        if self.type == "response_completed" and self.response_id is None:
            raise ValueError("response_completed event requires response_id")

        if self.type == "error" and self.message is None:
            raise ValueError("error event requires message")

        if self.type == "tool_call":
            missing_tool_call = (
                self.tool_call_id is None
                or self.tool_name is None
                or self.tool_arguments is None
            )
            if missing_tool_call:
                raise ValueError("tool_call event requires tool_call_id, tool_name, and tool_arguments")

        if self.type == "tool_result":
            missing_tool_result = (
                self.tool_call_id is None
                or self.tool_name is None
                or self.tool_output is None
                or self.tool_status is None
            )
            if missing_tool_result:
                raise ValueError("tool_result event requires tool_call_id, tool_name, tool_output, and tool_status")

        return self
