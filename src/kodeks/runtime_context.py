"""Runtime context assembly for Kodeks chat turns."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from .contracts import StoredPlanArtifact


def body_with_runtime_context(
    body: Mapping[str, Any],
    mode: str,
    active_plan: StoredPlanArtifact | None,
    memory_context: Mapping[str, list[dict[str, Any]]],
    selected_files: list[dict[str, Any]],
) -> dict[str, Any]:
    """Add model-facing runtime context while preserving the incoming request body."""

    next_body = dict(body)
    next_body["mode"] = mode
    instructions = build_runtime_instructions(
        mode, active_plan, memory_context, selected_files
    )
    if instructions:
        existing = _string_value(body.get("instructions"))
        next_body["instructions"] = (
            instructions if existing is None else f"{existing}\n\n{instructions}"
        )
    return next_body


def build_runtime_instructions(
    mode: str,
    active_plan: StoredPlanArtifact | None,
    memory_context: Mapping[str, list[dict[str, Any]]],
    selected_files: list[dict[str, Any]],
) -> str:
    """Build compact model instructions for Python runtime parity."""

    lines = [
        "You are Kodeks, a local-first coding agent.",
        "Reply in the user's language.",
        "Do not reveal hidden reasoning.",
        "Use function tools for workspace facts; do not write tool-call JSON in visible text.",
    ]
    if mode == "plan":
        lines.append("Plan mode is read-only; use only read-only tools.")
    lines.extend(
        [
            "",
            "Selected workspace files for this turn:",
            _format_selected_files_context(selected_files),
        ]
    )
    lines.extend(["", "Recalled memory:", _format_memory_context(memory_context)])
    if active_plan is not None:
        lines.extend(
            [
                "",
                "Active plan:",
                f"Title: {active_plan.title}",
                f"Summary: {active_plan.summary}",
            ]
        )
        for step in active_plan.steps:
            lines.append(f"- [{step.status}] {step.title}")
    return "\n".join(lines)


def selected_files_from_body(body: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Read user-selected file context from camelCase or snake_case payloads."""

    value = body.get("selectedFiles")
    if value is None:
        value = body.get("selected_files")
    if not isinstance(value, list):
        return []
    selected: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        path = _string_value(item.get("path"))
        if path is None:
            continue
        selected.append(
            {
                "path": path,
                "content": item.get("content")
                if isinstance(item.get("content"), str)
                else None,
                "error": item.get("error") if isinstance(item.get("error"), str) else None,
                "truncated": item.get("truncated") is True,
            }
        )
    return selected


def build_memory_context(database: Any, query: str) -> dict[str, list[dict[str, Any]]]:
    """Recall layered memories for the current user input."""

    layers = ["atom", "scenario", "artifact"]
    context = cast(
        dict[str, list[dict[str, Any]]],
        database.memories.recall_layered(query, 5, layers),
    )
    if memory_context_ids(context):
        return context
    merged: dict[str, list[dict[str, Any]]] = {
        "atoms": [],
        "scenarios": [],
        "artifacts": [],
    }
    seen: set[str] = set()
    for term in _memory_query_terms(query):
        recalled = cast(
            dict[str, list[dict[str, Any]]],
            database.memories.recall_layered(term, 5, layers),
        )
        for layer, rows in recalled.items():
            for row in rows:
                row_id = str(row.get("id") or row.get("refId") or "")
                if not row_id or row_id in seen:
                    continue
                seen.add(row_id)
                merged.setdefault(layer, []).append(row)
    return merged


def memory_context_ids(context: Mapping[str, list[dict[str, Any]]]) -> list[str]:
    """Return memory ids that should be exposed in memory_recalled events."""

    ids: list[str] = []
    for layer in ("profiles", "atoms", "scenarios"):
        for item in context.get(layer, []):
            item_id = item.get("id")
            if isinstance(item_id, str):
                ids.append(item_id)
    return ids


def memory_context_layer_counts(
    context: Mapping[str, list[dict[str, Any]]],
) -> dict[str, int]:
    """Count recalled memory layers for the UI display."""

    counts: dict[str, int] = {}
    mapping = {
        "profiles": "profile",
        "atoms": "atom",
        "scenarios": "scenario",
        "artifacts": "artifact",
    }
    for key, label in mapping.items():
        count = len(context.get(key, []))
        if count:
            counts[label] = count
    return counts


def _format_selected_files_context(selected_files: list[dict[str, Any]]) -> str:
    """Format selected workspace files as bounded model context."""

    if not selected_files:
        return "No files selected."
    lines = [
        "The user explicitly selected these workspace files. Use them as high-priority context when relevant. If a file is truncated or an answer needs more detail, call read_file with its path."
    ]
    for file in selected_files:
        suffix = " (truncated)" if file.get("truncated") is True else ""
        lines.append(f"\n--- {file['path']}{suffix} ---")
        if isinstance(file.get("error"), str):
            lines.append(f"Unable to read selected file: {file['error']}")
            continue
        lines.append(str(file.get("content") or ""))
    return "\n".join(lines)


def _format_memory_context(context: Mapping[str, list[dict[str, Any]]]) -> str:
    """Format layered memory as compact model instructions."""

    lines: list[str] = []
    for profile in context.get("profiles", []):
        lines.append(
            f"- [profile:{profile.get('scope') or 'project'}] {profile.get('content') or ''}"
        )
    for atom in context.get("atoms", []):
        lines.append(
            f"- [atom:{atom.get('scope') or 'project'}] {atom.get('content') or ''}"
        )
    for scenario in context.get("scenarios", []):
        title = scenario.get("title") or "scenario"
        summary = scenario.get("summary") or ""
        lines.append(f"- [scenario:{scenario.get('scope') or 'project'}] {title}: {summary}")
    for artifact in context.get("artifacts", []):
        ref_id = artifact.get("refId") or artifact.get("id") or "artifact"
        lines.append(
            f"- [artifact:{ref_id}] {artifact.get('summary') or ''} (use read_memory_artifact to inspect full output)"
        )
    return "\n".join(lines) if lines else "No recalled memories."


def _memory_query_terms(query: str) -> list[str]:
    """Extract stable fallback terms for simple literal memory search."""

    terms: list[str] = []
    for raw in query.replace("?", " ").replace("？", " ").split():
        term = raw.strip(".,:;!()[]{}'\"")
        if len(term) >= 4 or any("\u4e00" <= char <= "\u9fff" for char in term):
            terms.append(term)
    return terms[:6]


def _string_value(value: object) -> str | None:
    """Return a non-empty string value from unknown input."""

    return value.strip() if isinstance(value, str) and value.strip() else None
