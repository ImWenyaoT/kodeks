import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import kodeks.services.audit_service as audit_service
import kodeks.services.shell_service as shell_service
from kodeks.main import app


class ApprovalsRouteTest(unittest.TestCase):
    def test_approve_endpoint_executes_pending_command(self) -> None:
        """Verify the approval API executes a pending shell command once."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "mkdir approved_by_route"},
                log_path=audit_path,
            )

            with (
                patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path),
                patch.object(shell_service, "WORKSPACE_ROOT", root),
            ):
                client = TestClient(app)
                response = client.post(f"/api/approvals/{approval_id}/approve")
                repeat = client.post(f"/api/approvals/{approval_id}/approve")
                approved_dir_exists = (root / "approved_by_route").is_dir()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "executed")
        self.assertTrue(approved_dir_exists)
        self.assertEqual(repeat.status_code, 409)

    def test_reject_endpoint_does_not_execute_pending_command(self) -> None:
        """Verify rejecting a pending command records rejection without execution."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "mkdir rejected_by_route"},
                log_path=audit_path,
            )

            with (
                patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path),
                patch.object(shell_service, "WORKSPACE_ROOT", root),
            ):
                client = TestClient(app)
                response = client.post(
                    f"/api/approvals/{approval_id}/reject",
                    json={"reason": "too destructive"},
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "rejected")
        self.assertFalse((root / "rejected_by_route").exists())

    def test_missing_approval_returns_404(self) -> None:
        """Verify missing approval ids map to a clear HTTP 404."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                client = TestClient(app)
                response = client.get("/api/approvals/appr_missing")

        self.assertEqual(response.status_code, 404)

    def test_read_endpoint_returns_pending_approval_status(self) -> None:
        """Verify the approval read route returns pending metadata."""

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

            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                response = TestClient(app).get(f"/api/approvals/{approval_id}")

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "pending")
        self.assertEqual(payload["arguments_summary"], {"command": "pwd"})

    def test_reject_missing_approval_returns_404(self) -> None:
        """Verify rejecting an unknown approval id maps to HTTP 404."""

        with TemporaryDirectory() as tmp_dir:
            audit_path = Path(tmp_dir) / "tool_audit.jsonl"
            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                response = TestClient(app).post("/api/approvals/appr_missing/reject", json={})

        self.assertEqual(response.status_code, 404)

    def test_reject_resolved_approval_returns_409(self) -> None:
        """Verify a resolved approval cannot be rejected later."""

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
            audit_service.reject_approval(approval_id, log_path=audit_path)

            with patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path):
                response = TestClient(app).post(
                    f"/api/approvals/{approval_id}/reject",
                    json={"reason": "again"},
                )

        self.assertEqual(response.status_code, 409)

    def test_approve_timeout_returns_408(self) -> None:
        """Verify approved command timeouts map to HTTP 408."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            audit_path = root / "tool_audit.jsonl"
            approval_id = audit_service.record_approval_required(
                session_id="s1",
                tool_call_id="call_1",
                tool_name="run_shell",
                reason="needs approval",
                arguments_summary={"command": "sleep 99"},
                log_path=audit_path,
            )

            with (
                patch.object(audit_service, "TOOL_AUDIT_LOG_PATH", audit_path),
                patch.object(
                    shell_service,
                    "run_approved_command",
                    side_effect=shell_service.ShellCommandTimeoutError("sleep 99"),
                ),
            ):
                client = TestClient(app)
                response = client.post(f"/api/approvals/{approval_id}/approve")

        self.assertEqual(response.status_code, 408)


if __name__ == "__main__":
    unittest.main()
