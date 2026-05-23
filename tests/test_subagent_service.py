import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from kodeks.services.subagent_service import run_subagent


class SubagentServiceTest(unittest.TestCase):
    def test_run_subagent_records_isolated_task_summary(self) -> None:
        """Verify minimal subagent runs are logged with isolated input context."""

        with TemporaryDirectory() as tmp_dir:
            log_path = Path(tmp_dir) / "subagents.jsonl"
            result = run_subagent(
                task="Inspect workspace architecture",
                context="Focus on runtime and tools.",
                session_id="s1",
                log_path=log_path,
            )
            records = [
                json.loads(line)
                for line in log_path.read_text(encoding="utf-8").splitlines()
            ]

        self.assertTrue(result["subagent_id"].startswith("sub_"))
        self.assertEqual(result["status"], "completed")
        self.assertIn("Inspect workspace architecture", result["summary"])
        self.assertEqual(records[0]["session_id"], "s1")
        self.assertEqual(records[0]["context"], "Focus on runtime and tools.")

    def test_run_subagent_rejects_empty_task(self) -> None:
        """Verify subagents require an explicit task boundary."""

        with self.assertRaisesRegex(ValueError, "Subagent task is empty"):
            run_subagent(task=" ")


if __name__ == "__main__":
    unittest.main()
