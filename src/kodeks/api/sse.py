"""SSE helpers for preserving the existing Kodeks stream wire contract."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def sse_frame(event: str, data: Mapping[str, Any]) -> str:
    """Encode one named SSE frame with compact JSON data."""

    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def kodeks_event_frame(payload: Mapping[str, Any]) -> str:
    """Encode a Kodeks runtime event whose payload already contains `type`."""

    event = str(payload.get("type", "message"))
    return sse_frame(event, payload)
