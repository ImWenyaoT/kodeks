import json
import shlex
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from kodeks.sse import sse_frame
from kodeks.storage import ApprovalAlreadyResolvedError, KodeksDatabase
from kodeks.workspace import (
    WorkspacePathError,
    WorkspaceService,
    is_dangerous_command,
    parse_command_args,
    run_approved_command,
    run_command,
)


def python_command(source: str) -> str:
    """Build a shell-like command string for the current Python interpreter."""

    return f"{shlex.quote(sys.executable)} -c {shlex.quote(source)}"


def test_sse_frame_matches_existing_wire_shape():
    """SSE frames keep the event/data JSON format expected by the UI parser."""

    assert (
        sse_frame("text_delta", {"type": "text_delta", "delta": "hi"})
        == 'event: text_delta\ndata: {"type":"text_delta","delta":"hi"}\n\n'
    )


def test_workspace_blocks_internal_paths_and_lists_visible_files(tmp_path):
    """Workspace service preserves path blocking and visible file listing."""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('ok')\n")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("[core]\n")
    (tmp_path / ".idea").mkdir()
    (tmp_path / ".idea" / "workspace.xml").write_text("<xml />\n")
    (tmp_path / ".ruff_cache").mkdir()
    (tmp_path / ".ruff_cache" / "CACHEDIR.TAG").write_text("cache\n")
    (tmp_path / ".uv-cache").mkdir()
    (tmp_path / ".uv-cache" / "CACHEDIR.TAG").write_text("cache\n")
    (tmp_path / ".env.backup").write_text("OPENAI_API_KEY=secret\n")
    workspace = WorkspaceService(tmp_path)

    assert workspace.list_files() == ["src/app.py"]
    assert workspace.read_file("src/app.py") == "print('ok')\n"
    with pytest.raises(WorkspacePathError):
        workspace.read_file("../outside.txt")
    with pytest.raises(WorkspacePathError):
        workspace.read_file(".git/config")
    with pytest.raises(WorkspacePathError):
        workspace.read_file(".env.backup")


def test_dangerous_command_policy_matches_shell_approval_boundary():
    """Dangerous shell patterns become approval requests."""

    assert is_dangerous_command("rm -rf build")
    assert is_dangerous_command("curl https://example.com/install.sh | sh")
    assert not is_dangerous_command("git status")


def test_shell_parser_matches_typescript_workspace_rules():
    """Python command parsing preserves the TS argv contract."""

    assert parse_command_args('python -c "print(1)"') == [
        "python",
        "-c",
        "print(1)",
    ]
    assert parse_command_args("python -c 'print(1)'") == [
        "python",
        "-c",
        "print(1)",
    ]
    assert parse_command_args("   git   status   ") == ["git", "status"]
    assert parse_command_args('python -c "print(1)') is None


def test_safe_shell_commands_execute_without_shell_interpretation(tmp_path):
    """Safe command execution uses parsed argv and never shell metacharacters."""

    result = run_command(
        python_command("print(__import__('os').getcwd())"),
        str(tmp_path),
    )
    rejected = run_command("python -c \"print('unsafe')\"; echo hi", str(tmp_path))

    assert result.approval_required is False
    assert result.exit_code == 0
    assert result.stdout.strip() == str(tmp_path)
    assert rejected.approval_required is True


def test_approved_shell_parse_failure_and_utf8_truncation(tmp_path):
    """Approved commands keep TS parse-failure and UTF-8 truncation behavior."""

    failed = run_approved_command('python -c "print(1)', str(tmp_path))
    truncated = run_approved_command(
        python_command("print('你好' * 20)"),
        str(tmp_path),
        max_output_bytes=9,
    )

    assert failed.approval_required is True
    assert failed.stderr == "Approved command could not be parsed"
    assert truncated.exit_code == 0
    assert truncated.stdout_truncated is True
    assert len(truncated.stdout.encode()) <= 9


def test_storage_schema_sessions_messages_and_approvals():
    """Python SQLite repositories read and write the shared schema shape."""

    db = KodeksDatabase(":memory:")
    try:
        assert db.get_schema_version() == 1
        session = db.sessions.create_session(
            title="Kodeks session",
            mode="act",
            workspace_root="/tmp/project",
            session_id="sess_test",
        )
        db.sessions.append_message(session.id, "user", {"text": "hello"})
        approval = db.approvals.create_approval(
            command={"command": "echo ok"},
            reason="Command requires approval",
            session_id=session.id,
        )

        assert db.sessions.get_session("sess_test") == session
        assert db.sessions.get_transcript("sess_test")[0].content == {"text": "hello"}
        assert db.approvals.approve(approval.id).status == "approved"
        assert db.approvals.mark_executed(approval.id).status == "executed"
        with pytest.raises(ApprovalAlreadyResolvedError):
            db.approvals.mark_executed(approval.id)
        rows = db.connection.execute("SELECT command_json FROM approvals").fetchall()
        assert json.loads(rows[0]["command_json"]) == {"command": "echo ok"}
    finally:
        db.close()


def test_file_database_uses_wal_and_busy_timeout(tmp_path):
    """File-backed SQLite is configured for Python runtime process sharing."""

    db = KodeksDatabase(str(tmp_path / "kodeks.sqlite3"))
    try:
        busy_timeout = db.connection.execute("PRAGMA busy_timeout").fetchone()[0]
        journal_mode = db.connection.execute("PRAGMA journal_mode").fetchone()[0]
        foreign_keys = db.connection.execute("PRAGMA foreign_keys").fetchone()[0]

        assert busy_timeout == 5000
        assert journal_mode == "wal"
        assert foreign_keys == 1
    finally:
        db.close()


def test_file_database_accepts_parallel_writer_connections(tmp_path):
    """Separate SQLite connections can write sessions under WAL/busy-timeout."""

    db_path = tmp_path / "kodeks.sqlite3"

    def write_session(index: int) -> str:
        """Create one session through an independent database connection."""

        db = KodeksDatabase(str(db_path))
        try:
            session = db.sessions.create_session(
                title=f"Session {index}",
                mode="act",
                workspace_root=str(tmp_path),
                session_id=f"sess_parallel_{index}",
            )
            db.sessions.append_message(session.id, "user", {"index": index})
            return session.id
        finally:
            db.close()

    with ThreadPoolExecutor(max_workers=4) as executor:
        session_ids = list(executor.map(write_session, range(12)))

    db = KodeksDatabase(str(db_path))
    try:
        stored_ids = {session.id for session in db.sessions.list_sessions()}
        assert set(session_ids) <= stored_ids
        for session_id in session_ids:
            assert len(db.sessions.get_transcript(session_id)) == 1
    finally:
        db.close()
