import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import kodeks.services.audit_service as audit_service
import kodeks.services.shell_service as shell_service
import kodeks.services.workspace_service as workspace_service
from kodeks.tools.registry import (
    RECALL_MEMORY_TOOL_NAME,
    READ_FILE_TOOL_NAME,
    REMEMBER_FACT_TOOL_NAME,
    RUN_SHELL_TOOL_NAME,
    SPAWN_SUBAGENT_TOOL_NAME,
    WRITE_FILE_TOOL_NAME,
    build_default_tool_registry,
    execute_recall_memory,
    execute_read_file,
    execute_remember_fact,
    execute_run_shell,
    execute_spawn_subagent,
    execute_write_file,
    ToolExecutionContext,
)


class ToolRegistryTest(unittest.TestCase):
    def test_default_registry_exposes_phase5b_tools(self) -> None:
        """Verify Phase 5B registers read, write, and shell tools."""

        registry = build_default_tool_registry()
        definitions = registry.definitions()

        names = [definition.name for definition in definitions]
        self.assertEqual(
            names,
            [
                READ_FILE_TOOL_NAME,
                WRITE_FILE_TOOL_NAME,
                RUN_SHELL_TOOL_NAME,
                REMEMBER_FACT_TOOL_NAME,
                RECALL_MEMORY_TOOL_NAME,
                SPAWN_SUBAGENT_TOOL_NAME,
            ],
        )
        self.assertEqual(definitions[0].parameters["required"], ["path"])
        self.assertEqual(definitions[1].parameters["required"], ["path", "content"])
        self.assertEqual(definitions[2].parameters["required"], ["command"])

    def test_registry_can_filter_mutating_tools_for_plan_mode(self) -> None:
        """Verify plan mode can expose only non-mutating tools."""

        registry = build_default_tool_registry()
        tool_names = [definition.name for definition in registry.definitions(read_only_only=True)]

        self.assertEqual(
            tool_names,
            [READ_FILE_TOOL_NAME, RECALL_MEMORY_TOOL_NAME, SPAWN_SUBAGENT_TOOL_NAME],
        )

    def test_execute_read_file_returns_json_content(self) -> None:
        """Verify read_file tool output is model-readable JSON."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "README.md").write_text("# kodeks", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                result = execute_read_file({"path": "README.md"})

        self.assertEqual(result.status, "completed")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["path"], "README.md")
        self.assertEqual(payload["content"], "# kodeks")

    def test_execute_read_file_reuses_workspace_boundary(self) -> None:
        """Verify tool execution cannot bypass blocked workspace paths."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            git_dir = root / ".git"
            git_dir.mkdir()
            (git_dir / "config").write_text("secret", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                result = execute_read_file({"path": ".git/config"})

        self.assertEqual(result.status, "failed")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], False)
        self.assertEqual(payload["path"], ".git/config")
        self.assertIn("Path is blocked", payload["error"])

    def test_missing_path_argument_fails_cleanly(self) -> None:
        """Verify invalid model arguments become a structured tool failure."""

        result = execute_read_file({})

        self.assertEqual(result.status, "failed")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], False)
        self.assertIn("non-empty string path", payload["error"])

    def test_write_file_missing_arguments_fail_cleanly(self) -> None:
        """Verify write_file validates both required model arguments."""

        for arguments in [{}, {"path": "note.txt"}, {"content": "text"}]:
            with self.subTest(arguments=arguments):
                result = execute_write_file(arguments)

                self.assertEqual(result.status, "failed")
                self.assertFalse(json.loads(result.output)["ok"])

    def test_execute_write_file_uses_whole_file_overwrite(self) -> None:
        """Verify write_file writes complete content and reports overwrite metadata."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            existing = root / "output" / "note.txt"
            existing.parent.mkdir()
            existing.write_text("old", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                result = execute_write_file(
                    {"path": "output/note.txt", "content": "new text"}
                )
                content = workspace_service.read_file("output/note.txt")

        self.assertEqual(result.status, "completed")
        self.assertEqual(content, "new text")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["strategy"], "whole_file_overwrite")
        self.assertEqual(payload["overwritten"], True)
        self.assertEqual(payload["bytes_written"], len("new text".encode("utf-8")))

    def test_execute_write_file_reuses_workspace_boundary(self) -> None:
        """Verify write_file cannot write blocked internal workspace paths."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            state_dir = root / ".kodeks"
            state_dir.mkdir()

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                result = execute_write_file(
                    {"path": ".kodeks/session_state.sqlite3", "content": "bad"}
                )

        self.assertEqual(result.status, "failed")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], False)
        self.assertIn("Path is blocked", payload["error"])

    def test_execute_run_shell_executes_safe_command(self) -> None:
        """Verify run_shell executes safe commands inside the workspace."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)

            with patch.object(shell_service, "WORKSPACE_ROOT", root):
                result = execute_run_shell({"command": "pwd"})

        self.assertEqual(result.status, "completed")
        payload = json.loads(result.output)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(Path(payload["stdout"].strip()).resolve(), root.resolve())
        self.assertEqual(payload["approval_required"], False)

    def test_execute_run_shell_dangerous_command_requests_approval_and_audits(self) -> None:
        """Verify dangerous shell commands are not executed and create audit records."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                result = execute_run_shell(
                    {"command": "rm -rf output"},
                    ToolExecutionContext(session_id="s1", tool_call_id="call_shell"),
                )

            records = [
                json.loads(line)
                for line in audit_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(result.status, "approval_required")
        payload = json.loads(result.output)
        self.assertEqual(payload["approval_required"], True)
        self.assertTrue(payload["approval_id"].startswith("appr_"))
        self.assertEqual(records[0]["approval_id"], payload["approval_id"])
        self.assertEqual(records[0]["session_id"], "s1")
        self.assertEqual(records[0]["tool_call_id"], "call_shell")
        self.assertEqual(records[0]["tool_name"], RUN_SHELL_TOOL_NAME)
        self.assertEqual(records[0]["status"], "pending")

    def test_execute_run_shell_internal_path_requests_approval(self) -> None:
        """Verify shell cannot bypass workspace internal-path policy."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                result = execute_run_shell(
                    {"command": "cat .kodeks/session_state.sqlite3"},
                    ToolExecutionContext(session_id="s1", tool_call_id="call_shell"),
                )

        self.assertEqual(result.status, "approval_required")
        payload = json.loads(result.output)
        self.assertEqual(payload["approval_required"], True)
        self.assertIn(".kodeks/session_state.sqlite3", payload["command"])

    def test_execute_run_shell_missing_command_fails_cleanly(self) -> None:
        """Verify run_shell validates its required command argument."""

        for arguments in [{}, {"command": ""}, {"command": 123}]:
            with self.subTest(arguments=arguments):
                result = execute_run_shell(arguments)

                self.assertEqual(result.status, "failed")
                self.assertFalse(json.loads(result.output)["ok"])

    def test_memory_tools_remember_and_recall_facts(self) -> None:
        """Verify memory tools expose auditable remember and recall behavior."""

        with TemporaryDirectory() as tmp_dir:
            memory_path = Path(tmp_dir) / "memory.jsonl"
            with patch("kodeks.tools.registry.memory_service.MEMORY_LOG_PATH", memory_path):
                remembered = execute_remember_fact(
                    {"content": "Project uses FastAPI.", "scope": "project"},
                    ToolExecutionContext(session_id="s1", tool_call_id="call_mem"),
                )
                recalled = execute_recall_memory({"query": "FastAPI"})

        self.assertEqual(remembered.status, "completed")
        self.assertEqual(recalled.status, "completed")
        self.assertIn("Project uses FastAPI", recalled.output)

    def test_spawn_subagent_returns_summary_and_log_id(self) -> None:
        """Verify the subagent tool creates an isolated local subtask result."""

        with TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "subagents.jsonl"
            with patch("kodeks.tools.registry.subagent_service.SUBAGENT_LOG_PATH", log_path):
                result = execute_spawn_subagent(
                    {"task": "Review architecture", "context": "Focus runtime."},
                    ToolExecutionContext(session_id="s1", tool_call_id="call_sub"),
                )

        payload = json.loads(result.output)
        self.assertEqual(result.status, "completed")
        self.assertTrue(payload["subagent_id"].startswith("sub_"))
        self.assertIn("Review architecture", payload["summary"])

    def test_unknown_tool_fails_cleanly(self) -> None:
        """Verify registry returns a tool result instead of crashing on unknown tools."""

        registry = build_default_tool_registry()
        result = registry.execute("unknown_tool", {"command": "pwd"})

        self.assertEqual(result.status, "failed")
        self.assertIn("Unknown tool", json.loads(result.output)["error"])


if __name__ == "__main__":
    unittest.main()
