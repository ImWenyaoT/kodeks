import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import kodeks.api.routes.shell as shell_route
import kodeks.services.shell_service as shell_service
from kodeks.main import app


class ShellRouteTest(unittest.TestCase):
    def test_run_endpoint_returns_safe_command_result(self) -> None:
        """Verify the shell route exposes structured safe-command output."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with patch.object(shell_service, "WORKSPACE_ROOT", root):
                response = TestClient(app).post("/api/shell/run", json={"command": "pwd"})

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["exit_code"], 0)
        self.assertEqual(Path(payload["stdout"].strip()).resolve(), root.resolve())
        self.assertFalse(payload["approval_required"])
        self.assertFalse(payload["stdout_truncated"])
        self.assertFalse(payload["stderr_truncated"])

    def test_run_endpoint_reports_parse_failure_as_approval_required(self) -> None:
        """Verify malformed shell input is not executed through the route."""

        response = TestClient(app).post("/api/shell/run", json={"command": '"unterminated'})

        payload = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["approval_required"])
        self.assertIsNone(payload["exit_code"])

    def test_run_endpoint_maps_timeout_to_408(self) -> None:
        """Verify shell timeouts become HTTP 408 responses."""

        with patch.object(
            shell_route,
            "run_command",
            side_effect=shell_service.ShellCommandTimeoutError("sleep 99"),
        ):
            response = TestClient(app).post("/api/shell/run", json={"command": "sleep 99"})

        self.assertEqual(response.status_code, 408)
        self.assertEqual(response.json()["detail"], "Command timed out")


if __name__ == "__main__":
    unittest.main()
