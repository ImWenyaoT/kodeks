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

    def test_list_files_supports_limit(self) -> None:
        """Verify workspace listing can bound memory used by large repositories."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "a.txt").write_text("a", encoding="utf-8")
            (root / "b.txt").write_text("b", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                files = workspace_service.list_files(limit=1)

        self.assertEqual(len(files), 1)

    def test_list_files_does_not_materialize_sorted_directory_entries(self) -> None:
        """Verify workspace listing avoids sorted directory snapshots."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "a.txt").write_text("a", encoding="utf-8")

            with (
                patch.object(workspace_service, "WORKSPACE_ROOT", root),
                patch("builtins.sorted", side_effect=AssertionError("sorted should not be used")),
            ):
                files = workspace_service.list_files()

        self.assertEqual(files, ["a.txt"])

    def test_list_files_uses_cache_until_write_invalidates_it(self) -> None:
        """Verify workspace listing avoids repeated scans and refreshes after writes."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "a.txt").write_text("a", encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                workspace_service.invalidate_file_list_cache()
                first_files = workspace_service.list_files()
                (root / "b.txt").write_text("b", encoding="utf-8")
                cached_files = workspace_service.list_files()
                refreshed_files = workspace_service.list_files(refresh=True)
                workspace_service.write_file("c.txt", "c")
                invalidated_files = workspace_service.list_files()

        self.assertEqual(first_files, ["a.txt"])
        self.assertEqual(cached_files, ["a.txt"])
        self.assertIn("b.txt", refreshed_files)
        self.assertIn("c.txt", invalidated_files)

    def test_list_files_cache_expires_after_ttl(self) -> None:
        """Verify cached listings refresh after the configured TTL."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            (root / "a.txt").write_text("a", encoding="utf-8")

            with (
                patch.object(workspace_service, "WORKSPACE_ROOT", root),
                patch.object(workspace_service, "monotonic", return_value=0.0),
            ):
                workspace_service.invalidate_file_list_cache()
                first_files = workspace_service.list_files()

            (root / "b.txt").write_text("b", encoding="utf-8")

            with (
                patch.object(workspace_service, "WORKSPACE_ROOT", root),
                patch.object(
                    workspace_service,
                    "monotonic",
                    return_value=workspace_service.WORKSPACE_LIST_CACHE_TTL_SECONDS + 0.1,
                ),
            ):
                expired_files = workspace_service.list_files()

        self.assertEqual(first_files, ["a.txt"])
        self.assertIn("b.txt", expired_files)

    def test_large_text_file_is_rejected(self) -> None:
        """Verify read_file refuses files that would bloat memory and model context."""

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            large_file = root / "large.txt"
            large_file.write_text("x" * (workspace_service.MAX_TEXT_FILE_BYTES + 1), encoding="utf-8")

            with patch.object(workspace_service, "WORKSPACE_ROOT", root):
                with self.assertRaisesRegex(ValueError, "File is too large"):
                    workspace_service.read_file("large.txt")

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
