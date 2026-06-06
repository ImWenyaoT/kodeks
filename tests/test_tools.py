import json

from kodeks.storage import KodeksDatabase
from kodeks.tools.registry import (
    build_default_tool_registry,
)
from kodeks.tools.schemas import (
    default_tool_definitions,
    tool_definitions_by_name,
)
from kodeks.tools.types import (
    ToolExecutionContext,
    ToolRegistryServices,
)
from kodeks.workspace import WorkspaceService


def test_tool_registry_definitions_and_read_only_filter(tmp_path):
    """Python registry returns stable definitions and plan-mode read-only tools."""

    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(WorkspaceService(tmp_path), db)
        )

        assert registry.definitions() == default_tool_definitions()
        assert set(tool_definitions_by_name()) == {
            definition["name"] for definition in default_tool_definitions()
        }
        assert [definition["name"] for definition in registry.definitions()] == [
            "read_file",
            "write_file",
            "grep",
            "run_shell",
            "remember_fact",
            "recall_memory",
            "read_memory_artifact",
            "spawn_explore_agent",
            "list_mcp_servers",
        ]
        assert [
            definition["name"] for definition in registry.definitions(read_only_only=True)
        ] == [
            "read_file",
            "grep",
            "recall_memory",
            "read_memory_artifact",
            "spawn_explore_agent",
            "list_mcp_servers",
        ]
        assert registry.has("read_file") is True
        assert registry.has("glob") is False
        assert json.loads(registry.execute("glob", {}).output)["error"] == (
            "Unknown tool: glob"
        )
    finally:
        db.close()


def test_tool_registry_executes_workspace_file_tools(tmp_path):
    """read_file and write_file execute through the workspace boundary."""

    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(WorkspaceService(tmp_path), db)
        )

        written = registry.execute(
            "write_file", {"path": "notes/demo.md", "content": "hello"}
        )
        read = registry.execute("read_file", {"path": "notes/demo.md"})
        blocked = registry.execute("read_file", {"path": ".git/config"})

        assert written.status == "completed"
        assert json.loads(written.output)["strategy"] == "whole_file_overwrite"
        assert json.loads(read.output)["content"] == "hello"
        assert blocked.status == "failed"
    finally:
        db.close()


def test_tool_registry_greps_visible_workspace_files(tmp_path):
    """grep searches visible files and skips blocked internals."""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("marker = 'kodeks'\n")
    (tmp_path / "src" / "b.py").write_text("nothing here\n")
    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(WorkspaceService(tmp_path), db)
        )

        result = registry.execute("grep", {"query": "kodeks"})

        assert json.loads(result.output)["matches"] == [
            {"path": "src/a.py", "line": 1, "text": "marker = 'kodeks'"}
        ]
    finally:
        db.close()


def test_tool_registry_records_shell_approval_requests(tmp_path):
    """Dangerous run_shell calls become durable approval records and audit rows."""

    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(WorkspaceService(tmp_path), db)
        )

        result = registry.execute(
            "run_shell",
            {"command": "rm -rf output"},
            ToolExecutionContext("s1", "call_1"),
        )
        output = json.loads(result.output)
        approval = db.approvals.get_approval(output["approvalId"])
        audit = db.connection.execute("SELECT * FROM audit_log").fetchone()

        assert result.status == "approval_required"
        assert output["approvalRequired"] is True
        assert approval.session_id == "s1"
        assert approval.tool_call_id == "call_1"
        assert audit["event_type"] == "approval_required"
    finally:
        db.close()


def test_tool_registry_memory_and_subagent_tools(tmp_path):
    """Memory and explore tools preserve the harness output contract."""

    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(WorkspaceService(tmp_path), db)
        )

        remembered = registry.execute(
            "remember_fact",
            {"content": "Kodeks plan mode is read only.", "scope": "project"},
            ToolExecutionContext("s1", "call_1"),
        )
        recalled = registry.execute("recall_memory", {"query": "plan mode"})
        subagent = registry.execute(
            "spawn_explore_agent",
            {"task": "inspect workspace package"},
            ToolExecutionContext("s1", "call_2"),
        )
        subagent_output = json.loads(subagent.output)
        audit_events = [
            row["event_type"]
            for row in db.connection.execute(
                "SELECT event_type FROM audit_log ORDER BY rowid ASC"
            ).fetchall()
        ]

        assert json.loads(remembered.output)["scope"] == "project"
        assert json.loads(recalled.output)["memories"][0]["sourceSessionId"] == "s1"
        assert json.loads(recalled.output)["layered"]["atoms"][0]["content"] == (
            "Kodeks plan mode is read only."
        )
        assert subagent_output["status"] == "completed"
        assert subagent_output["allowedTools"] == [
            "read_file",
            "grep",
            "recall_memory",
            "read_memory_artifact",
        ]
        assert subagent_output["parentSessionId"] == "s1"
        assert subagent_output["contract"]["claim"] == (
            "Read-only workspace exploration completed."
        )
        assert subagent_output["contract"]["confidence"] in {"low", "medium"}
        assert subagent_output["quarantine"] == {
            "readOnly": True,
            "canMutateWorkspace": False,
            "canRequestApproval": False,
        }
        assert db.subagents.get_run(subagent_output["runId"])["parentSessionId"] == "s1"
        assert audit_events == ["subagent_started", "subagent_completed"]
    finally:
        db.close()


def test_tool_registry_lists_mcp_manifests(tmp_path):
    """MCP tool reads local configuration without opening network clients."""

    db = KodeksDatabase(":memory:")
    try:
        registry = build_default_tool_registry(
            ToolRegistryServices(
                WorkspaceService(tmp_path),
                db,
                {
                    "KODEKS_MCP_SERVERS": json.dumps(
                        [
                            {
                                "label": "deepwiki",
                                "url": "https://example.com/mcp",
                                "allowedTools": ["search"],
                                "skipApproval": True,
                            }
                        ]
                    ),
                },
            )
        )

        mcp = registry.execute("list_mcp_servers", {})

        assert json.loads(mcp.output)["servers"][0]["label"] == "deepwiki"
    finally:
        db.close()
