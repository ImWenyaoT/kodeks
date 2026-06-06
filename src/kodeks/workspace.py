"""Workspace boundary and shell policy for the Python Kodeks runtime."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

BLOCKED_PATH_PARTS = {
    ".git",
    ".idea",
    ".kodeks",
    ".ruff_cache",
    ".uv-cache",
    ".venv",
    ".pytest_cache",
    ".mypy_cache",
    ".DS_Store",
    "__pycache__",
    "dist",
    "node_modules",
}

BLOCKED_FILENAME_PREFIXES = (".env",)

DANGEROUS_PATTERNS = [
    re.compile(pattern, re.IGNORECASE)
    for pattern in [
        r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b",
        r"\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b",
        r"\bsudo\b",
        r"\bgit\s+reset\s+--hard\b",
        r"\bgit\s+clean\s+-fd\b",
        r"\bchmod\s+-R\b",
        r"\bchown\s+-R\b",
        r"\bcurl\b.*\|\s*(sh|bash)\b",
        r"\bwget\b.*\|\s*(sh|bash)\b",
        r"[;&|`$<>]",
        r"(^|[\s'\"`])\.\.(/|$)",
        r"(^|[\s'\"`])(\.git|\.kodeks|\.venv|node_modules)(/|$)",
    ]
]
SHELL_ONLY_SYNTAX = re.compile(r"[;&|`$<>]")
SHELL_ONLY_ERROR = (
    "run_shell executes commands without a shell; remove pipes, redirects, "
    "command substitutions, variables, or control operators and call one "
    "executable with plain arguments."
)


class WorkspacePathError(RuntimeError):
    """Raised when a path escapes or targets blocked workspace internals."""


class ShellCommandTimeoutError(RuntimeError):
    """Raised when a subprocess exceeds the configured timeout."""


@dataclass(frozen=True)
class ShellResult:
    """Shell execution result returned by the approval-aware harness."""

    command: str
    exit_code: int | None
    stdout: str
    stderr: str
    approval_required: bool
    stdout_truncated: bool
    stderr_truncated: bool

    def to_wire(self) -> dict[str, object]:
        """Serialize the shell result using existing camelCase field names."""

        return {
            "command": self.command,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "approvalRequired": self.approval_required,
            "stdoutTruncated": self.stdout_truncated,
            "stderrTruncated": self.stderr_truncated,
        }


class WorkspaceService:
    """File and listing access scoped to one authorized project root."""

    def __init__(
        self, root: str | os.PathLike[str], max_text_file_bytes: int = 1_000_000
    ) -> None:
        self.root = Path(root).resolve()
        self.max_text_file_bytes = max_text_file_bytes

    def root_path(self) -> str:
        """Return the absolute authorized workspace root."""

        return str(self.root)

    def resolve_path(self, relative_path: str) -> Path:
        """Resolve a workspace-relative path and reject escapes/internal paths."""

        target = (self.root / relative_path).resolve()
        try:
            relative = target.relative_to(self.root)
        except ValueError as exc:
            raise WorkspacePathError("Path escapes workspace") from exc
        if not relative.parts:
            raise WorkspacePathError("Path escapes workspace")
        if _is_blocked_workspace_path(relative):
            raise WorkspacePathError("Path is blocked")
        return target

    def read_file(self, relative_path: str) -> str:
        """Read a UTF-8 text file from the authorized workspace."""

        target = self.resolve_path(relative_path)
        if not target.is_file():
            raise FileNotFoundError(f"File not found: {relative_path}")
        if target.stat().st_size > self.max_text_file_bytes:
            raise RuntimeError("File is too large")
        return target.read_text()

    def write_file(self, relative_path: str, content: str) -> None:
        """Write UTF-8 text using whole-file overwrite semantics."""

        if len(content.encode()) > self.max_text_file_bytes:
            raise RuntimeError("File is too large")
        target = self.resolve_path(relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def list_files(self, limit: int | None = None) -> list[str]:
        """List visible workspace files while pruning blocked subtrees."""

        files: list[str] = []
        for directory, dirnames, filenames in os.walk(self.root):
            dirnames[:] = sorted(
                dirname for dirname in dirnames if dirname not in BLOCKED_PATH_PARTS
            )
            for filename in sorted(filenames):
                if _is_blocked_workspace_filename(filename):
                    continue
                path = Path(directory) / filename
                relative = path.relative_to(self.root).as_posix()
                if _is_blocked_workspace_path(Path(relative)):
                    continue
                files.append(relative)
                if limit is not None and len(files) >= limit:
                    return files
        return files


def _is_blocked_workspace_filename(filename: str) -> bool:
    """Return whether a filename is internal, generated, or secret-like."""

    return filename in BLOCKED_PATH_PARTS or filename.startswith(
        BLOCKED_FILENAME_PREFIXES
    )


def _is_blocked_workspace_path(relative: Path) -> bool:
    """Return whether a relative workspace path targets hidden runtime internals."""

    return any(part in BLOCKED_PATH_PARTS for part in relative.parts) or any(
        _is_blocked_workspace_filename(part) for part in relative.parts
    )


def is_dangerous_command(command: str) -> bool:
    """Return whether a command requires human approval."""

    return any(pattern.search(command) for pattern in DANGEROUS_PATTERNS)


def run_command(
    command: str,
    cwd: str,
    timeout_ms: int = 10_000,
    max_output_bytes: int = 65_536,
) -> ShellResult:
    """Run a safe parsed command without a shell, or request approval."""

    if has_shell_only_syntax(command):
        return unsupported_shell_syntax_result(command)
    if is_dangerous_command(command):
        return ShellResult(
            command=command,
            exit_code=None,
            stdout="",
            stderr="Command requires approval",
            approval_required=True,
            stdout_truncated=False,
            stderr_truncated=False,
        )
    return run_approved_command(
        command, cwd, timeout_ms, max_output_bytes, "Command requires approval"
    )


def run_approved_command(
    command: str,
    cwd: str,
    timeout_ms: int = 10_000,
    max_output_bytes: int = 65_536,
    parse_failure_message: str = "Approved command could not be parsed",
) -> ShellResult:
    """Run a command after approval has already been granted by a higher layer."""

    if has_shell_only_syntax(command):
        return unsupported_shell_syntax_result(command)
    args = parse_command_args(command)
    if args is None:
        return ShellResult(command, None, "", parse_failure_message, True, False, False)
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
        )
    except subprocess.TimeoutExpired as exc:
        raise ShellCommandTimeoutError(f"Shell command timed out: {command}") from exc
    stdout, stdout_truncated = _truncate(completed.stdout, max_output_bytes)
    stderr, stderr_truncated = _truncate(completed.stderr, max_output_bytes)
    return ShellResult(
        command,
        completed.returncode,
        stdout,
        stderr,
        False,
        stdout_truncated,
        stderr_truncated,
    )


def parse_command_args(command: str) -> list[str] | None:
    """Parse shell-like argv without invoking a shell."""

    args: list[str] = []
    current = ""
    quote: str | None = None
    for char in command:
        if quote is not None:
            if char == quote:
                quote = None
            else:
                current += char
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char.isspace():
            if current:
                args.append(current)
                current = ""
            continue
        current += char
    if quote is not None:
        return None
    if current:
        args.append(current)
    return args or None


def has_shell_only_syntax(command: str) -> bool:
    """Return whether a command needs a shell feature Kodeks does not execute."""

    return SHELL_ONLY_SYNTAX.search(command) is not None


def unsupported_shell_syntax_result(command: str) -> ShellResult:
    """Return a non-approval failure for commands that need shell parsing."""

    return ShellResult(command, None, "", SHELL_ONLY_ERROR, False, False, False)


def _truncate(value: str, max_bytes: int) -> tuple[str, bool]:
    """Truncate text to a byte budget while preserving UTF-8 boundaries."""

    encoded = value.encode()
    if len(encoded) <= max_bytes:
        return value, False
    return encoded[:max_bytes].decode(errors="ignore"), True
