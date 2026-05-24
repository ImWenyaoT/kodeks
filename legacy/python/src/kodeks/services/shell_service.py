# q1: coding agent 为什么需要 shell harness？
# a1: 只会读写文件还不够，agent 还需要运行测试、格式化、lint、启动服务等命令，才能形成“修改代码 -> 验证结果 -> 继续修复”的工程闭环。
# q2: 为什么不能把系统 shell 直接暴露给模型？
# a2: shell 可以删除文件、修改权限、联网执行脚本，甚至让进程长期卡住；所以这里先用 service 层统一限制工作目录、超时和危险命令拦截。
# q3: 第一版危险命令识别解决了什么业务风险？还有什么局限？
# a3: 它先把 rm/sudo/git reset/curl|sh、内部路径访问和明显路径逃逸转成 approval_required，避免 agent 静默破坏或读取 workspace 私有状态；但 regex 只是 MVP guardrail，后续还要做 approval id、审计日志和更严格的命令解析。
# q4: 后续 shell 工具设计参考谁？
# a4: approval/permission 边界优先参考 /src 的权限与工具执行模型，再用 opencode 的 shell/permission 测试做第二对照；不能因为已有 run_command API 就直接暴露给模型。

import re
import shlex
import subprocess
from dataclasses import dataclass

from kodeks.core.config import WORKSPACE_ROOT

MAX_OUTPUT_BYTES = 65_536


DANGEROUS_PATTERNS = [
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
    r"(^|[\s'\"`])(\.git|\.kodeks|\.venv)(/|$)",
]


class ShellCommandTimeoutError(Exception):
    """Raised when a shell command exceeds the configured timeout."""


@dataclass
class ShellResult:
    command: str
    exit_code: int | None
    stdout: str
    stderr: str
    approval_required: bool = False
    stdout_truncated: bool = False
    stderr_truncated: bool = False


def is_dangerous_command(command: str) -> bool:
    """Return True if a shell command requires human approval."""
    return any(re.search(pattern, command, flags=re.IGNORECASE) for pattern in DANGEROUS_PATTERNS)


def run_command(command: str) -> ShellResult:
    """Run a shell command inside the workspace."""
    if is_dangerous_command(command):
        return ShellResult(
            command=command,
            exit_code=None,
            stdout="",
            stderr="Command requires approval",
            approval_required=True,
        )

    args = _command_args(command)
    if args is None:
        return ShellResult(
            command=command,
            exit_code=None,
            stdout="",
            stderr="Command requires approval",
            approval_required=True,
        )

    try:
        completed = subprocess.run(
            args,
            shell=False,
            cwd=WORKSPACE_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise ShellCommandTimeoutError(command) from exc

    stdout, stdout_truncated = _truncate_output(completed.stdout)
    stderr, stderr_truncated = _truncate_output(completed.stderr)

    return ShellResult(
        command=command,
        exit_code=completed.returncode,
        stdout=stdout,
        stderr=stderr,
        stdout_truncated=stdout_truncated,
        stderr_truncated=stderr_truncated,
    )


def run_approved_command(command: str) -> ShellResult:
    """Run a human-approved shell command inside the workspace."""
    args = _command_args(command)
    if args is None:
        return ShellResult(
            command=command,
            exit_code=None,
            stdout="",
            stderr="Approved command could not be parsed",
        )

    try:
        completed = subprocess.run(
            args,
            shell=False,
            cwd=WORKSPACE_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise ShellCommandTimeoutError(command) from exc

    stdout, stdout_truncated = _truncate_output(completed.stdout)
    stderr, stderr_truncated = _truncate_output(completed.stderr)

    return ShellResult(
        command=command,
        exit_code=completed.returncode,
        stdout=stdout,
        stderr=stderr,
        stdout_truncated=stdout_truncated,
        stderr_truncated=stderr_truncated,
    )


def _command_args(command: str) -> list[str] | None:
    """Parse a shell-like command into argv without enabling shell interpretation."""

    try:
        args = shlex.split(command)
    except ValueError:
        return None

    return args or None


def _truncate_output(text: str) -> tuple[str, bool]:
    """Return output bounded to MAX_OUTPUT_BYTES without splitting UTF-8 characters."""

    encoded = text.encode("utf-8")
    if len(encoded) <= MAX_OUTPUT_BYTES:
        return text, False

    truncated = encoded[:MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore")
    return truncated, True
