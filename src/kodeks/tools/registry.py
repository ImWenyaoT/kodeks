# q1: 为什么 Phase 5A/5B 要先做 tool registry，而不是在 runtime 里 if tool_name == "read_file"？
# a1: registry 把“工具定义”“工具元数据”和“工具执行”集中管理，runtime 只负责编排流程。这样增加 write_file、run_shell 时，不会把 agent loop 写成一堆分散条件分支。
# q2: 为什么 read_file tool 复用 workspace_service，而不是重新读 Path？
# a2: agent 工具不是新的文件系统入口。它必须复用 Phase 1 已验证的 workspace boundary 和内部路径 blocklist，避免模型绕过安全边界。
# q3: Phase 5B 为什么 run_shell 遇到危险命令只返回 approval_required？
# a3: shell 是最高风险工具。Phase 5B 的目标是把 mutating/shell 工具接入 loop，并建立可见的 permission gate 和 audit trail；真正批准/拒绝接口留到 Phase 6。
# q4: registry 的设计参考谁？
# a4: 工具编排思路优先参考 /src/services/tools/toolOrchestration.ts 的“编排和执行分离”，再用 opencode 的 tool registry 和 permission ask 模型做结构对照；实现保持最小 Python 版本。

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from kodeks.runtime.provider import ToolDefinition
from kodeks.services import audit_service, memory_service, shell_service, subagent_service
from kodeks.services import workspace_service

READ_FILE_TOOL_NAME = "read_file"
WRITE_FILE_TOOL_NAME = "write_file"
RUN_SHELL_TOOL_NAME = "run_shell"
REMEMBER_FACT_TOOL_NAME = "remember_fact"
RECALL_MEMORY_TOOL_NAME = "recall_memory"
SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent"


@dataclass(frozen=True)
class ToolExecutionContext:
    """Context the runtime passes to tool handlers for audit and permission records."""

    session_id: str | None = None
    tool_call_id: str | None = None


@dataclass(frozen=True)
class ToolExecutionResult:
    """Result of one local tool execution."""

    status: str
    output: str


@dataclass(frozen=True)
class RegisteredTool:
    """Pair one provider-facing tool definition with its local executor."""

    definition: ToolDefinition
    handler: Callable[[dict[str, Any], ToolExecutionContext], ToolExecutionResult]
    read_only: bool = False
    mutating: bool = False
    permission_key: str | None = None


class ToolRegistry:
    """Registry for the model-callable tools exposed by the runtime."""

    def __init__(self, tools: list[RegisteredTool]) -> None:
        self._tools = {tool.definition.name: tool for tool in tools}
        self._definitions = [tool.definition for tool in self._tools.values()]
        self._read_only_definitions = [
            tool.definition
            for tool in self._tools.values()
            if tool.read_only and not tool.mutating
        ]

    def definitions(self, *, read_only_only: bool = False) -> list[ToolDefinition]:
        """Return provider-neutral tool definitions in stable registration order."""

        if read_only_only:
            return self._read_only_definitions
        return self._definitions

    def execute(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        context: ToolExecutionContext | None = None,
    ) -> ToolExecutionResult:
        """Execute a registered tool or return a structured failure."""

        tool = self._tools.get(tool_name)
        if tool is None:
            return _failed_output(f"Unknown tool: {tool_name}")

        return tool.handler(arguments, context or ToolExecutionContext())


def build_default_tool_registry() -> ToolRegistry:
    """Build the default registry for the current Phase 5B tool loop."""

    return ToolRegistry(
        [
            RegisteredTool(
                definition=read_file_tool_definition(),
                handler=execute_read_file,
                read_only=True,
                permission_key="workspace.read",
            ),
            RegisteredTool(
                definition=write_file_tool_definition(),
                handler=execute_write_file,
                mutating=True,
                permission_key="workspace.write",
            ),
            RegisteredTool(
                definition=run_shell_tool_definition(),
                handler=execute_run_shell,
                mutating=True,
                permission_key="shell.run",
            ),
            RegisteredTool(
                definition=remember_fact_tool_definition(),
                handler=execute_remember_fact,
                mutating=True,
                permission_key="memory.write",
            ),
            RegisteredTool(
                definition=recall_memory_tool_definition(),
                handler=execute_recall_memory,
                read_only=True,
                permission_key="memory.read",
            ),
            RegisteredTool(
                definition=spawn_subagent_tool_definition(),
                handler=execute_spawn_subagent,
                read_only=True,
                permission_key="subagent.spawn",
            ),
        ]
    )


def read_file_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for the read_file workspace tool."""

    return ToolDefinition(
        name=READ_FILE_TOOL_NAME,
        description="Read a UTF-8 text file from the authorized workspace.",
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative file path, such as README.md.",
                }
            },
            "required": ["path"],
        },
    )


def write_file_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for the write_file workspace tool."""

    return ToolDefinition(
        name=WRITE_FILE_TOOL_NAME,
        description=(
            "Write UTF-8 text to a workspace file using whole-file overwrite semantics. "
            "Use this only when the full desired file content is known."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative file path, such as output/notes.md.",
                },
                "content": {
                    "type": "string",
                    "description": "Complete UTF-8 text content to write to the file.",
                },
            },
            "required": ["path", "content"],
        },
    )


def run_shell_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for the run_shell workspace tool."""

    return ToolDefinition(
        name=RUN_SHELL_TOOL_NAME,
        description=(
            "Run a non-dangerous shell command in the authorized workspace. "
            "Dangerous commands return approval_required instead of executing."
        ),
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command to run from the workspace root, such as pwd or python -m unittest.",
                }
            },
            "required": ["command"],
        },
    )


def remember_fact_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for writing one auditable memory fact."""

    return ToolDefinition(
        name=REMEMBER_FACT_TOOL_NAME,
        description=(
            "Save one durable memory fact about user preferences, project facts, "
            "or lessons learned. Store only stable, useful facts."
        ),
        parameters={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "The memory fact to store.",
                },
                "scope": {
                    "type": "string",
                    "description": "Memory scope: user, project, or session.",
                },
            },
            "required": ["content"],
        },
    )


def recall_memory_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for recalling relevant memory facts."""

    return ToolDefinition(
        name=RECALL_MEMORY_TOOL_NAME,
        description="Recall relevant durable memory records for the current task.",
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search terms for relevant memories.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of memory records to return.",
                },
            },
            "required": ["query"],
        },
    )


def spawn_subagent_tool_definition() -> ToolDefinition:
    """Return the model-facing schema for spawning a minimal isolated subagent task."""

    return ToolDefinition(
        name=SPAWN_SUBAGENT_TOOL_NAME,
        description=(
            "Run a small isolated subagent task and return its auditable summary. "
            "Use for independent analysis or verification work."
        ),
        parameters={
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The isolated task for the subagent.",
                },
                "context": {
                    "type": "string",
                    "description": "Optional context to provide to the subagent.",
                },
            },
            "required": ["task"],
        },
    )


def execute_read_file(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Run the read_file tool through the shared workspace service boundary."""

    raw_path = arguments.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return _failed_output("read_file requires a non-empty string path")

    path = raw_path.strip()
    try:
        content = workspace_service.read_file(path)
    except (FileNotFoundError, OSError, UnicodeDecodeError, ValueError) as exc:
        return _failed_output(str(exc), path=path)

    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": True,
                "path": path,
                "content": content,
            }
        ),
    )


def execute_write_file(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Run the write_file tool through whole-file overwrite semantics."""

    raw_path = arguments.get("path")
    raw_content = arguments.get("content")

    if not isinstance(raw_path, str) or not raw_path.strip():
        return _failed_output("write_file requires a non-empty string path")
    if not isinstance(raw_content, str):
        return _failed_output("write_file requires string content", path=raw_path.strip())

    path = raw_path.strip()
    try:
        target_path = workspace_service.resolve_workspace_path(path)
        overwritten = target_path.is_file()
        workspace_service.write_file(path, raw_content)
    except (OSError, ValueError) as exc:
        return _failed_output(str(exc), path=path)

    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": True,
                "path": path,
                "strategy": "whole_file_overwrite",
                "overwritten": overwritten,
                "bytes_written": len(raw_content.encode("utf-8")),
            }
        ),
    )


def execute_run_shell(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Run safe shell commands and convert dangerous commands into approval requests."""

    raw_command = arguments.get("command")
    if not isinstance(raw_command, str) or not raw_command.strip():
        return _failed_output("run_shell requires a non-empty string command")

    command = raw_command.strip()
    context = context or ToolExecutionContext()
    if shell_service.is_dangerous_command(command):
        reason = "Command matches dangerous shell policy"
        approval_id = audit_service.record_approval_required(
            session_id=context.session_id,
            tool_call_id=context.tool_call_id,
            tool_name=RUN_SHELL_TOOL_NAME,
            reason=reason,
            arguments_summary={"command": command},
        )
        return ToolExecutionResult(
            status="approval_required",
            output=_json_output(
                {
                    "ok": False,
                    "approval_required": True,
                    "approval_id": approval_id,
                    "status": "pending",
                    "reason": reason,
                    "command": command,
                }
            ),
        )

    try:
        result = shell_service.run_command(command)
    except shell_service.ShellCommandTimeoutError:
        return _failed_output("Command timed out")

    if result.approval_required:
        reason = result.stderr or "Command requires approval"
        approval_id = audit_service.record_approval_required(
            session_id=context.session_id,
            tool_call_id=context.tool_call_id,
            tool_name=RUN_SHELL_TOOL_NAME,
            reason=reason,
            arguments_summary={"command": command},
        )
        return ToolExecutionResult(
            status="approval_required",
            output=_json_output(
                {
                    "ok": False,
                    "approval_required": True,
                    "approval_id": approval_id,
                    "status": "pending",
                    "reason": reason,
                    "command": command,
                }
            ),
        )

    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": result.exit_code == 0,
                "command": result.command,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "approval_required": False,
            }
        ),
    )


def execute_remember_fact(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Store one memory fact through the shared memory service."""

    raw_content = arguments.get("content")
    raw_scope = arguments.get("scope", "project")
    if not isinstance(raw_content, str) or not raw_content.strip():
        return _failed_output("remember_fact requires non-empty string content")
    if not isinstance(raw_scope, str) or not raw_scope.strip():
        return _failed_output("remember_fact requires string scope")

    context = context or ToolExecutionContext()
    try:
        memory_id = memory_service.JSONLMemoryStore().remember(
            raw_content,
            scope=raw_scope.strip(),
            source_session_id=context.session_id,
        )
    except ValueError as exc:
        return _failed_output(str(exc))

    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": True,
                "memory_id": memory_id,
                "scope": raw_scope.strip(),
                "content": raw_content.strip(),
            }
        ),
    )


def execute_recall_memory(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Recall relevant memory records through the shared memory service."""

    raw_query = arguments.get("query")
    raw_limit = arguments.get("limit", 5)
    if not isinstance(raw_query, str) or not raw_query.strip():
        return _failed_output("recall_memory requires a non-empty string query")

    limit = raw_limit if isinstance(raw_limit, int) else 5
    records = memory_service.JSONLMemoryStore().recall(raw_query, limit=limit)
    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": True,
                "query": raw_query.strip(),
                "memories": records,
            }
        ),
    )


def execute_spawn_subagent(
    arguments: dict[str, Any],
    context: ToolExecutionContext | None = None,
) -> ToolExecutionResult:
    """Run a minimal subagent task and return its summary as tool output."""

    raw_task = arguments.get("task")
    raw_context = arguments.get("context", "")
    if not isinstance(raw_task, str) or not raw_task.strip():
        return _failed_output("spawn_subagent requires a non-empty string task")
    if not isinstance(raw_context, str):
        return _failed_output("spawn_subagent requires string context")

    context = context or ToolExecutionContext()
    try:
        result = subagent_service.run_subagent(
            task=raw_task,
            context=raw_context,
            session_id=context.session_id,
        )
    except ValueError as exc:
        return _failed_output(str(exc))

    return ToolExecutionResult(
        status="completed",
        output=_json_output(
            {
                "ok": True,
                "subagent_id": result["subagent_id"],
                "status": result["status"],
                "summary": result["summary"],
            }
        ),
    )


def _failed_output(message: str, path: str | None = None) -> ToolExecutionResult:
    """Create a JSON tool output for failures the model can explain to users."""

    payload: dict[str, object] = {
        "ok": False,
        "error": message,
    }
    if path is not None:
        payload["path"] = path

    return ToolExecutionResult(
        status="failed",
        output=_json_output(payload),
    )


def _json_output(payload: dict[str, object]) -> str:
    """Serialize tool output as compact JSON for provider tool-result messages."""

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
