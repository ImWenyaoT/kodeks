# q1: coding agent 为什么需要 workspace 文件层，而不是直接让模型碰本机文件系统？
# a1: 因为真实产品里 agent 只能操作用户授权的项目目录；workspace 层把“可见、可读、可写”的范围收窄到项目内。
# q2: 你的 agent 能读写文件，怎么防止它读取项目外的敏感文件？
# a2: 所有用户传入路径都会先基于 workspace root 做 resolve，再检查真实路径是否仍在 workspace 内。
# q3: 只防止 ../ 路径逃逸够吗？
# a3: 不够。真实工程里还要禁止 .git、.venv、缓存目录等内部路径，否则 agent 虽然没逃出 workspace，
#     但仍可能读到 token、依赖缓存、Git remote 信息或无意义的大文件。
# q4: 追问：为什么 list/read/write 要共用同一套路径策略？
# a4: 否则会出现“列表里隐藏了 .git，但 read_file 仍能读取 .git/config”的安全不一致。

from pathlib import Path

from kodeks.core.config import WORKSPACE_ROOT

BLOCKED_PATH_PARTS = {
    ".git",
    ".kodeks",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".DS_Store",
}


def is_blocked_workspace_path(path: Path) -> bool:
    """Return whether a workspace path points to internal or ignored project data."""
    relative_path = path.relative_to(WORKSPACE_ROOT.resolve())
    return any(part in BLOCKED_PATH_PARTS for part in relative_path.parts)


def list_files() -> list[str]:
    """Return all files under the workspace as relative paths."""
    files: list[str] = []
    workspace_root = WORKSPACE_ROOT.resolve()

    for path in workspace_root.rglob("*"):
        if is_blocked_workspace_path(path):
            continue

        if path.is_file():
            relative_path = path.relative_to(workspace_root)
            files.append(str(relative_path))

    return files


def resolve_workspace_path(relative_path: str) -> Path:
    """Resolve a user-provided path and ensure it stays inside the workspace."""
    workspace_root = WORKSPACE_ROOT.resolve()
    target_path = (workspace_root / relative_path).resolve()

    if workspace_root != target_path and workspace_root not in target_path.parents:
        raise ValueError("Path escapes workspace")

    if is_blocked_workspace_path(target_path):
        raise ValueError("Path is blocked")

    return target_path


def read_file(relative_path: str) -> str:
    """Read a text file inside the workspace."""
    path = resolve_workspace_path(relative_path)

    if not path.is_file():
        raise FileNotFoundError(f"File not found: {relative_path}")

    return path.read_text(encoding="utf-8")


def write_file(relative_path: str, content: str) -> None:
    """Write text content to a file inside the workspace."""
    path = resolve_workspace_path(relative_path)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
