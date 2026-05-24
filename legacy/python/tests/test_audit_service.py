import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import kodeks.services.audit_service as audit_service
import kodeks.services.shell_service as shell_service


class AuditServiceTest(unittest.TestCase):
    def test_approve_pending_shell_command_executes_once(self) -> None:
        """Verify approving a pending shell command executes and records the result."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "mkdir approved_dir"},
                log_path=audit_path,
            )

            with patch.object(shell_service, "WORKSPACE_ROOT", root):
                result = audit_service.approve_approval(approval_id, log_path=audit_path)

            approved_dir_exists = (root / "approved_dir").is_dir()
            records = [
                json.loads(line)
                for line in audit_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertEqual(result["status"], "executed")
        self.assertTrue(approved_dir_exists)
        self.assertEqual([record["status"] for record in records], ["pending", "approved", "executed"])
        self.assertEqual(records[-1]["result"]["exit_code"], 0)

    def test_reject_pending_shell_command_does_not_execute(self) -> None:
        """Verify rejecting a pending shell command records the rejection only."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "mkdir rejected_dir"},
                log_path=audit_path,
            )

            with patch.object(shell_service, "WORKSPACE_ROOT", root):
                result = audit_service.reject_approval(
                    approval_id,
                    reason="not needed",
                    log_path=audit_path,
                )

        self.assertEqual(result["status"], "rejected")
        self.assertFalse((root / "rejected_dir").exists())
        self.assertEqual(result["reason"], "not needed")

    def test_resolved_approval_cannot_be_approved_twice(self) -> None:
        """Verify an approval id cannot execute more than once."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "mkdir once"},
                log_path=audit_path,
            )

            with patch.object(shell_service, "WORKSPACE_ROOT", root):
                audit_service.approve_approval(approval_id, log_path=audit_path)
                with self.assertRaises(audit_service.ApprovalAlreadyResolvedError):
                    audit_service.approve_approval(approval_id, log_path=audit_path)

    def test_approval_without_command_cannot_execute(self) -> None:
        """Verify malformed pending approval records cannot execute shell commands."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={},
                log_path=audit_path,
            )

            with self.assertRaisesRegex(ValueError, "does not contain a shell command"):
                audit_service.approve_approval(approval_id, log_path=audit_path)

    def test_missing_approval_id_raises_not_found(self) -> None:
        """Verify unknown approval ids are explicit domain errors."""

        with TemporaryDirectory() as tmp_dir:
            with self.assertRaises(audit_service.ApprovalNotFoundError):
                audit_service.get_approval_status(
                    "appr_missing",
                    log_path=Path(tmp_dir) / "tool_audit.jsonl",
                )

    def test_malformed_audit_lines_do_not_break_status_lookup(self) -> None:
        """Verify a corrupted JSONL record cannot break unrelated approvals."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            audit_path.write_text("{bad json\n", encoding="utf-8")
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "pwd"},
                log_path=audit_path,
            )

            status = audit_service.get_approval_status(approval_id, log_path=audit_path)

        self.assertEqual(status["status"], "pending")

    def test_approval_lookup_keeps_only_first_and_latest_matching_record(self) -> None:
        """Verify approval lookup does not materialize every matching audit record."""

        records = [
            {"approval_id": "appr_1", "status": "pending", "decision": "ask"},
            {"approval_id": "other", "status": "pending", "decision": "ask"},
            {"approval_id": "appr_1", "status": "approved", "decision": "approve"},
            {"approval_id": "appr_1", "status": "executed", "decision": "execute"},
        ]

        first_record, latest_record = audit_service._find_approval_record_bounds(
            "appr_1",
            records,
        )

        self.assertEqual(first_record["status"], "pending")
        self.assertEqual(latest_record["status"], "executed")

    def test_approval_status_lookup_uses_cache_when_log_is_unchanged(self) -> None:
        """Verify repeated status lookups avoid rescanning unchanged audit logs."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "pwd"},
                log_path=audit_path,
            )

            first_status = audit_service.get_approval_status(approval_id, log_path=audit_path)
            with patch.object(
                Path,
                "open",
                side_effect=AssertionError("audit log should not be reopened"),
            ):
                cached_status = audit_service.get_approval_status(approval_id, log_path=audit_path)

        self.assertEqual(first_status["status"], "pending")
        self.assertEqual(cached_status["status"], "pending")


if __name__ == "__main__":
    unittest.main()
