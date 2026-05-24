from pydantic import BaseModel
from typing import Literal


class ChatStreamRequest(BaseModel):
    """Request body for one streaming chat turn."""

    input: str
    previous_response_id: str | None = None
    session_id: str | None = None
    mode: Literal["act", "plan"] = "act"
