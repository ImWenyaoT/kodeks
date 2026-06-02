"""Tool argument parsing, discovery, and output helpers."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .types import ToolArguments, ToolExecutionResult, ToolRegistryServices


def string_argument(
    arguments: ToolArguments, name: str, allow_empty: bool = False
) -> str | None:
    """Read a required string argument from model-provided JSON."""

    value = arguments.get(name)
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not allow_empty and not trimmed:
        return None
    return value if allow_empty else trimmed


def clamp_integer(value: object, minimum: int, maximum: int, fallback: int) -> int:
    """Read and clamp a numeric argument from model-provided JSON."""

    if not isinstance(value, int) or isinstance(value, bool):
        return fallback
    return min(maximum, max(minimum, value))


def read_memory_layers(value: object) -> list[str]:
    """Read optional memory layer filters from model-provided JSON."""

    if not isinstance(value, list):
        return ["atom", "scenario", "artifact"]
    layers = [
        item
        for item in value
        if item in {"atom", "scenario", "artifact"} and isinstance(item, str)
    ]
    return layers or ["atom", "scenario", "artifact"]


def read_mcp_server_manifests(
    environment: Mapping[str, str | None],
) -> list[dict[str, Any]]:
    """Read MCP server manifests from environment variables."""

    raw_servers = environment.get("KODEKS_MCP_SERVERS")
    if raw_servers:
        return parse_mcp_server_manifests(raw_servers)
    url = environment.get("KODEKS_MCP_SERVER_URL")
    if not url:
        return []
    return [
        {
            "label": environment.get("KODEKS_MCP_SERVER_LABEL") or "default",
            "url": url.strip(),
            "allowedTools": split_csv(environment.get("KODEKS_MCP_ALLOWED_TOOLS")),
            "skipApproval": environment.get("KODEKS_MCP_SKIP_APPROVAL") == "true",
        }
    ]


def parse_mcp_server_manifests(raw_servers: str) -> list[dict[str, Any]]:
    """Parse JSON MCP manifests while discarding malformed entries."""

    try:
        parsed = json.loads(raw_servers)
    except json.JSONDecodeError:
        return []
    items = parsed if isinstance(parsed, list) else [parsed]
    manifests: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label = item.get("label")
        url = item.get("url")
        if not isinstance(label, str) or not isinstance(url, str):
            continue
        raw_allowed = item.get("allowedTools")
        allowed_tools = (
            [tool for tool in raw_allowed if isinstance(tool, str)]
            if isinstance(raw_allowed, list)
            else split_csv(raw_allowed if isinstance(raw_allowed, str) else None)
        )
        manifests.append(
            {
                "label": label,
                "url": url,
                "allowedTools": allowed_tools,
                "skipApproval": item.get("skipApproval") is True,
            }
        )
    return manifests


def split_csv(value: str | None) -> list[str]:
    """Split comma-separated environment values into non-empty tokens."""

    if value is None:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def discover_skills(services: ToolRegistryServices) -> list[dict[str, str]]:
    """Discover SKILL.md files from configured roots."""

    skills: list[dict[str, str]] = []
    for root in skill_roots(services):
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir(), key=lambda item: item.name):
            skill_path = child / "SKILL.md"
            if not child.is_dir() or not skill_path.is_file():
                continue
            content = skill_path.read_text()
            skills.append(
                {
                    "name": child.name,
                    "title": read_markdown_title(content) or child.name,
                    "path": str(skill_path),
                }
            )
    return skills


def skill_roots(services: ToolRegistryServices) -> list[Path]:
    """Resolve skill roots from env or the workspace-local default."""

    environment = runtime_environment(services)
    configured = split_csv(environment.get("KODEKS_SKILLS_PATHS"))
    roots = (
        configured
        if configured
        else [str(Path(services.workspace.root_path()) / ".kodeks" / "skills")]
    )
    return [Path(os.path.expanduser(root)).resolve() for root in roots]


def read_markdown_title(content: str) -> str | None:
    """Read the first markdown heading as a skill title."""

    for line in content.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def completed_output(payload: dict[str, Any]) -> ToolExecutionResult:
    """Create a successful JSON tool result."""

    return ToolExecutionResult("completed", json_output(payload))


def failed_output(
    message: str, extra: dict[str, Any] | None = None
) -> ToolExecutionResult:
    """Create a failed JSON tool result."""

    return ToolExecutionResult(
        "failed", json_output({"ok": False, "error": message, **(extra or {})})
    )


def json_output(payload: dict[str, Any]) -> str:
    """Serialize tool outputs compactly for model-facing tool messages."""

    return json.dumps(payload, separators=(",", ":"))


def runtime_environment(services: ToolRegistryServices) -> Mapping[str, str | None]:
    """Return configured tool environment or process env."""

    return services.environment if services.environment is not None else os.environ


def error_message(error: object) -> str:
    """Convert unknown thrown values into readable tool errors."""

    return str(error)
