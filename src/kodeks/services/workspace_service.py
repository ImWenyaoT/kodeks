from kodeks.core.config import WORKSPACE_ROOT

IGNORE_DIRS = {".git", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".DS_Store"}


def list_files() -> list[str]:
    """Return all files under the workspace as relative paths."""
    files: list[str] = []

    for path in WORKSPACE_ROOT.rglob("*"):
        relative_path = path.relative_to(WORKSPACE_ROOT)

        if any(part in IGNORE_DIRS for part in relative_path.parts):
            continue

        if path.is_file():
            files.append(str(relative_path))

    return files