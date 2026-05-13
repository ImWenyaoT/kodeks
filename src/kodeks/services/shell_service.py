import re
import subprocess
from dataclasses import dataclass

from kodeks.core.config import WORKSPACE_ROOT


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

    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=WORKSPACE_ROOT,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except subprocess.TimeoutExpired as exc:
        raise ShellCommandTimeoutError(command) from exc

    return ShellResult(
        command=command,
        exit_code=completed.returncode,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )
