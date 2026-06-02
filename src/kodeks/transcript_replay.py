"""Compatibility exports for conversation-state replay helpers."""

from __future__ import annotations

from .conversation_state import (
    build_responses_input_from_messages,
    build_responses_input_from_transcript,
)

__all__ = [
    "build_responses_input_from_messages",
    "build_responses_input_from_transcript",
]
