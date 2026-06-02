"""Plan artifact parsing helpers for Kodeks plan-mode turns."""

from __future__ import annotations

from typing import Any


def build_plan_artifact_content(
    user_prompt: str, assistant_text: str
) -> dict[str, Any]:
    """Extract a minimal structured plan from a plan-mode assistant answer."""

    lines = [
        line.strip()
        for line in assistant_text.splitlines()
        if line.strip()
    ]
    title = _read_plan_title(lines) or _compact_text(user_prompt, 80) or "Kodeks plan"
    summary = _read_plan_summary(lines, title) or _compact_text(assistant_text, 240)
    steps = _read_plan_steps(lines)
    if not steps:
        steps = [
            {
                "id": "step_1",
                "title": summary or "Review the generated plan",
                "status": "pending",
                "details": None,
            }
        ]
    return {"title": title, "summary": summary, "steps": steps}


def _read_plan_title(lines: list[str]) -> str | None:
    """Read a markdown heading or first short non-step line as plan title."""

    for line in lines:
        if line.startswith("#"):
            return _compact_text(line.lstrip("#").strip(), 80)
    for line in lines:
        if not _is_plan_step_line(line):
            return _compact_text(line.rstrip(":："), 80)
    return None


def _read_plan_summary(lines: list[str], title: str) -> str | None:
    """Read the first concise non-heading and non-step line as summary."""

    for line in lines:
        normalized = line.lstrip("#").strip()
        if (
            normalized
            and normalized != title
            and not _is_plan_step_line(line)
            and normalized.lower().rstrip(":：") not in {"summary", "steps", "plan"}
            and normalized.rstrip(":：") not in {"摘要", "计划", "步骤"}
        ):
            return _compact_text(normalized, 240)
    return None


def _read_plan_steps(lines: list[str]) -> list[dict[str, Any]]:
    """Extract numbered, bulleted, and checkbox lines as plan steps."""

    steps: list[dict[str, Any]] = []
    for line in lines:
        title = _plan_step_title(line)
        if title is None:
            continue
        steps.append(
            {
                "id": f"step_{len(steps) + 1}",
                "title": _compact_text(title, 160),
                "status": "completed" if "[x]" in line.lower() else "pending",
                "details": None,
            }
        )
    return steps


def _is_plan_step_line(line: str) -> bool:
    """Return whether a line looks like a markdown plan step."""

    return _plan_step_title(line) is not None


def _plan_step_title(line: str) -> str | None:
    """Return a normalized plan step title from common markdown markers."""

    stripped = line.strip()
    for marker in ("- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "* [X] "):
        if stripped.startswith(marker):
            return stripped[len(marker) :].strip()
    for marker in ("- ", "* "):
        if stripped.startswith(marker):
            return stripped[len(marker) :].strip()
    index = 0
    while index < len(stripped) and stripped[index].isdigit():
        index += 1
    if index > 0 and index < len(stripped) and stripped[index] in {".", ")", "、"}:
        return stripped[index + 1 :].strip()
    return None


def _compact_text(text: str, max_length: int) -> str:
    """Collapse whitespace and trim long model text for stable plan fields."""

    normalized = " ".join(text.split()).strip()
    if len(normalized) <= max_length:
        return normalized
    return normalized[: max(0, max_length - 1)].rstrip()
