import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

import kodeks.services.workspace_service as workspace_service
from kodeks.main import app


class WorkspaceRouteTest(unittest.TestCase):
    def test_files_endpoint_returns_empty_workspace(self) -> None:
        """Verify the workspace file listing route handles an empty project."""

        with TemporaryDirectory() as tmp_dir:
            with patch.object(workspace_service, "WORKSPACE_ROOT", Path(tmp_dir)):
                workspace_service.invalidate_file_list_cache()
                response = TestClient(app).get("/api/workspace/files")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"files": []})

    def test_read_endpoint_maps_missing_file_to_404(self) -> None:
        """Verify missing workspace files become a route-level 404."""

        with TemporaryDirectory() as tmp_dir:
            with patch.object(workspace_service, "WORKSPACE_ROOT", Path(tmp_dir)):
                response = TestClient(app).get("/api/workspace/read", params={"path": "missing.txt"})

        self.assertEqual(response.status_code, 404)
        self.assertIn("File not found", response.json()["detail"])

    def test_read_endpoint_maps_blocked_path_to_403(self) -> None:
        """Verify blocked internal workspace paths become a route-level 403."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            git_dir = root / ".git"
            git_dir.mkdir()
            (git_dir / "config").write_text("secret", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                response = TestClient(app).get("/api/workspace/read", params={"path": ".git/config"})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"], "Path is blocked")

    def test_write_endpoint_accepts_empty_file_content(self) -> None:
        """Verify empty file content is valid input for whole-file writes."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                response = TestClient(app).post(
                    "/api/workspace/write",
                    json={"path": "empty.txt", "content": ""},
                )
                content = workspace_service.read_file("empty.txt")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "written")
        self.assertEqual(content, "")

    def test_write_endpoint_maps_blocked_path_to_403(self) -> None:
        """Verify writes to internal workspace paths are rejected by the route."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / ".kodeks").mkdir()

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                response = TestClient(app).post(
                    "/api/workspace/write",
                    json={"path": ".kodeks/state.json", "content": "{}"},
                )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"], "Path is blocked")


if __name__ == "__main__":
    unittest.main()
