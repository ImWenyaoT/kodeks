import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import kodeks.services.workspace_service as workspace_service


class WorkspaceServiceTest(unittest.TestCase):
    def test_read_write_and_list_stay_inside_workspace(self) -> None:
        """Verify workspace operations share the same containment boundary."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                workspace_service.write_file("output/probe.txt", "ok")

                self.assertEqual(workspace_service.read_file("output/probe.txt"), "ok")
                self.assertIn("output/probe.txt", workspace_service.list_files())

    def test_missing_file_raises_file_not_found(self) -> None:
        """Verify missing workspace files surface as FileNotFoundError."""

        with TemporaryDirectory() as tmp_dir:
            with patch.object(workspace_service, "WORKSPACE_ROOT", Path(tmp_dir)):
                with self.assertRaises(FileNotFoundError):
                    workspace_service.read_file("missing.txt")

    def test_path_escape_is_blocked(self) -> None:
        """Verify relative path traversal cannot escape the workspace."""

        with TemporaryDirectory() as tmp_dir:
            with patch.object(workspace_service, "WORKSPACE_ROOT", Path(tmp_dir)):
                with self.assertRaisesRegex(ValueError, "Path escapes workspace"):
                    workspace_service.read_file("../../.ssh/id_rsa")

    def test_internal_paths_are_blocked_for_read_and_list(self) -> None:
        """Verify internal project paths remain hidden and unreadable."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            git_dir = root / ".git"
            git_dir.mkdir()
            (git_dir / "config").write_text("secret", encoding="utf-8")
            state_dir = root / ".kodeks"
            state_dir.mkdir()
            (state_dir / "session_state.sqlite3").write_text("runtime state", encoding="utf-8")
            (root / "README.md").write_text("# ok", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                self.assertEqual(workspace_service.list_files(), ["README.md"])

                with self.assertRaisesRegex(ValueError, "Path is blocked"):
                    workspace_service.read_file(".git/config")

                with self.assertRaisesRegex(ValueError, "Path is blocked"):
                    workspace_service.read_file(".kodeks/session_state.sqlite3")


if __name__ == "__main__":
    unittest.main()
