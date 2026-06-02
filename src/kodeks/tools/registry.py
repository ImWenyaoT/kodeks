"""Deterministic local tool definitions for Python runtime parity."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..storage import KodeksDatabase
from ..workspace import (
    ShellCommandTimeoutError,
    WorkspaceService,
    run_command,
)
from .schemas import ToolDefinition, default_tool_definitions

ToolArguments = Mapping[str, Any]
ToolExecutionStatus = str


@dataclass(frozen=True)
class ToolExecutionContext:
    """Carries session and tool-call ids into approval and audit records."""

    session_id: str | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolExecutionResult:
    """Model-facing tool execution result."""

    status: ToolExecutionStatus
    output: str


@dataclass(frozen=True)
class ToolRegistryServices:
    """Service bundle used by deterministic local tool handlers."""

    workspace: WorkspaceService
    database: KodeksDatabase
    environment: Mapping[str, str | None] | None = None


@dataclass(frozen=True)
class RegisteredTool:
    """One registered tool definition and its Python handler."""

    definition: ToolDefinition
    read_only: bool
    mutating: bool
    handler: Callable[[ToolArguments, ToolExecutionContext], ToolExecutionResult]


class ToolRegistry:
    """Stores deterministic tool definitions and handlers by public tool name."""

    def __init__(self, tools: list[RegisteredTool]) -> None:
        self._tools = {tool.definition["name"]: tool for tool in tools}

    def definitions(self, read_only_only: bool = False) -> list[ToolDefinition]:
        """Return provider-facing definitions in stable registration order."""

        return [
            tool.definition
            for tool in self._tools.values()
            if not read_only_only or (tool.read_only and not tool.mutating)
        ]

    def has(self, tool_name: str) -> bool:
        """Return whether a tool name is registered."""

        return tool_name in self._tools

    def execute(
        self,
        tool_name: str,
        arguments: ToolArguments,
        context: ToolExecutionContext | None = None,
    ) -> ToolExecutionResult:
        """Execute one registered tool and convert unknown tools into failures."""

        tool = self._tools.get(tool_name)
        if tool is None:
            return failed_output(f"Unknown tool: {tool_name}")
        return tool.handler(arguments, context or ToolExecutionContext())


def build_default_tool_registry(services: ToolRegistryServices) -> ToolRegistry:
    """Build the default Kodeks tool registry from local services."""

    definitions = default_tool_definitions()
    return ToolRegistry(
        [
            RegisteredTool(
                definitions[0],
                True,
                False,
                lambda arguments, context: execute_read_file(arguments, services),
            ),
            RegisteredTool(
                definitions[1],
                False,
                True,
                lambda arguments, context: execute_write_file(arguments, services),
            ),
            RegisteredTool(
                definitions[2],
                True,
                False,
                lambda arguments, context: execute_grep(arguments, services),
            ),
            RegisteredTool(
                definitions[3],
                False,
                True,
                lambda arguments, context: execute_run_shell(
                    arguments, context, services
                ),
            ),
            RegisteredTool(
                definitions[4],
                False,
                True,
                lambda arguments, context: execute_remember_fact(
                    arguments, context, services
                ),
            ),
            RegisteredTool(
                definitions[5],
                True,
                False,
                lambda arguments, context: execute_recall_memory(arguments, services),
            ),
            RegisteredTool(
                definitions[6],
                True,
                False,
                lambda arguments, context: execute_read_memory_artifact(
                    arguments, services
                ),
            ),
            RegisteredTool(
                definitions[7],
                True,
                False,
                lambda arguments, context: execute_spawn_explore_agent(
                    arguments, context, services
                ),
            ),
            RegisteredTool(
                definitions[8],
                True,
                False,
                lambda arguments, context: execute_list_mcp_servers(services),
            ),
            RegisteredTool(
                definitions[9],
                True,
                False,
                lambda arguments, context: execute_list_skills(arguments, services),
            ),
            RegisteredTool(
                definitions[10],
                True,
                False,
                lambda arguments, context: execute_read_skill(arguments, services),
            ),
        ]
    )


def execute_read_file(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Execute read_file through the shared workspace boundary."""

    path = string_argument(arguments, "path")
    if path is None:
        return failed_output("read_file requires a non-empty string path")
    try:
        return completed_output(
            {"ok": True, "path": path, "content": services.workspace.read_file(path)}
        )
    except Exception as exc:
        return failed_output(error_message(exc), {"path": path})


def execute_write_file(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Execute write_file with whole-file overwrite semantics."""

    path = string_argument(arguments, "path")
    content = string_argument(arguments, "content", allow_empty=True)
    if path is None:
        return failed_output("write_file requires a non-empty string path")
    if content is None:
        return failed_output("write_file requires string content", {"path": path})
    try:
        services.workspace.write_file(path, content)
        return completed_output(
            {
                "ok": True,
                "path": path,
                "strategy": "whole_file_overwrite",
                "bytesWritten": len(content.encode()),
            }
        )
    except Exception as exc:
        return failed_output(error_message(exc), {"path": path})


def execute_grep(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Execute a literal grep over visible workspace text files."""

    query = string_argument(arguments, "query")
    limit = clamp_integer(arguments.get("limit"), 1, 1000, 20)
    if query is None:
        return failed_output("grep requires a non-empty string query")
    matches: list[dict[str, Any]] = []
    for path in services.workspace.list_files():
        if len(matches) >= limit:
            break
        try:
            content = services.workspace.read_file(path)
        except Exception:
            continue
        for index, line in enumerate(content.splitlines(), start=1):
            if query in line:
                matches.append({"path": path, "line": index, "text": line})
            if len(matches) >= limit:
                break
    return completed_output({"ok": True, "query": query, "matches": matches})


def execute_run_shell(
    arguments: ToolArguments,
    context: ToolExecutionContext,
    services: ToolRegistryServices,
) -> ToolExecutionResult:
    """Execute run_shell and record approval requests for dangerous commands."""

    command = string_argument(arguments, "command")
    if command is None:
        return failed_output("run_shell requires a non-empty string command")
    try:
        result = run_command(command, services.workspace.root_path())
    except ShellCommandTimeoutError:
        return failed_output("Command timed out")
    except Exception as exc:
        return failed_output(error_message(exc))
    if result.approval_required:
        approval = services.database.approvals.create_approval(
            command={"command": command},
            reason=result.stderr,
            session_id=context.session_id,
            tool_call_id=context.tool_call_id,
        )
        services.database.audit_log.record(
            context.session_id,
            "approval_required",
            {"approvalId": approval.id, "command": command},
        )
        return ToolExecutionResult(
            "approval_required",
            json_output(
                {
                    "ok": False,
                    "approvalRequired": True,
                    "approvalId": approval.id,
                    "status": approval.status,
                    "reason": approval.reason,
                    "command": command,
                }
            ),
        )
    return completed_output(
        {
            "ok": result.exit_code == 0,
            "command": command,
            "exitCode": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "approvalRequired": False,
        }
    )


def execute_remember_fact(
    arguments: ToolArguments,
    context: ToolExecutionContext,
    services: ToolRegistryServices,
) -> ToolExecutionResult:
    """Execute remember_fact through the memory repository."""

    content = string_argument(arguments, "content")
    scope = string_argument(arguments, "scope") or "project"
    if content is None:
        return failed_output("remember_fact requires non-empty string content")
    memory_id = services.database.memories.remember(
        scope, content, context.session_id
    )
    return completed_output(
        {"ok": True, "memoryId": memory_id, "scope": scope, "content": content}
    )


def execute_recall_memory(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Execute recall_memory through the memory repository."""

    query = string_argument(arguments, "query")
    limit = clamp_integer(arguments.get("limit"), 1, 50, 5)
    if query is None:
        return failed_output("recall_memory requires a non-empty string query")
    layers = read_memory_layers(arguments.get("layers"))
    return completed_output(
        {
            "ok": True,
            "query": query,
            "layers": layers,
            "memories": services.database.memories.recall(query, limit),
            "layered": services.database.memories.recall_layered(
                query, limit, layers
            ),
        }
    )


def execute_read_memory_artifact(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Execute read_memory_artifact through the memory repository."""

    ref_id = string_argument(arguments, "refId")
    if ref_id is None:
        return failed_output("read_memory_artifact requires a non-empty string refId")
    artifact = services.database.memories.read_artifact_content(ref_id)
    if artifact is None:
        return failed_output(f"Unknown memory artifact: {ref_id}", {"refId": ref_id})
    return completed_output({"ok": True, "refId": ref_id, **artifact})


def execute_spawn_explore_agent(
    arguments: ToolArguments,
    context: ToolExecutionContext,
    services: ToolRegistryServices,
) -> ToolExecutionResult:
    """Execute a minimal read-only explore subagent run."""

    task = string_argument(arguments, "task")
    if task is None:
        return failed_output("spawn_explore_agent requires a non-empty string task")
    run = services.database.subagents.start_run(
        context.session_id or "session_unknown", "explore", task
    )
    summary = f"Explore agent completed task: {task}"
    completed = services.database.subagents.complete_run(str(run["id"]), summary)
    return completed_output(
        {
            "ok": True,
            "runId": completed["id"],
            "status": completed["status"],
            "summary": completed["summary"],
        }
    )


def execute_list_mcp_servers(services: ToolRegistryServices) -> ToolExecutionResult:
    """List configured MCP server manifests without opening network clients."""

    servers = read_mcp_server_manifests(runtime_environment(services))
    return completed_output({"ok": True, "servers": servers, "count": len(servers)})


def execute_list_skills(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """List available skill directories and titles."""

    query = string_argument(arguments, "query")
    limit = clamp_integer(arguments.get("limit"), 1, 50, 20)
    skills = discover_skills(services)
    if query is not None:
        lowered = query.lower()
        skills = [
            skill
            for skill in skills
            if lowered in f"{skill['name']}\n{skill['title']}".lower()
        ]
    return completed_output({"ok": True, "skills": skills[:limit]})


def execute_read_skill(
    arguments: ToolArguments, services: ToolRegistryServices
) -> ToolExecutionResult:
    """Read one discovered skill body by exact directory name."""

    name = string_argument(arguments, "name")
    if name is None:
        return failed_output("read_skill requires a non-empty string name")
    for skill in discover_skills(services):
        if skill["name"] == name:
            path = Path(str(skill["path"]))
            return completed_output(
                {
                    "ok": True,
                    "name": skill["name"],
                    "title": skill["title"],
                    "content": path.read_text(),
                }
            )
    return failed_output(f"Unknown skill: {name}")


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
