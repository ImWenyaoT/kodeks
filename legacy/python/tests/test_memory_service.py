import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from kodeks.services.memory_service import JSONLMemoryStore


class JSONLMemoryStoreTest(unittest.TestCase):
    def test_remember_and_recall_relevant_memory(self) -> None:
        """Verify memory records can be stored and recalled by query terms."""

        with TemporaryDirectory() as tmp_dir:
            store = JSONLMemoryStore(Path(tmp_dir) / "memory.jsonl")
            memory_id = store.remember(
                "User prefers pytest and high coverage.",
                scope="user",
                source_session_id="s1",
            )
            store.remember("Project uses FastAPI routes.", scope="project")

            results = store.recall("coverage pytest", limit=1)

        self.assertTrue(memory_id.startswith("mem_"))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["content"], "User prefers pytest and high coverage.")
        self.assertEqual(results[0]["scope"], "user")

    def test_empty_memory_is_rejected(self) -> None:
        """Verify blank memory content is not written to permanent state."""

        with TemporaryDirectory() as tmp_dir:
            store = JSONLMemoryStore(Path(tmp_dir) / "memory.jsonl")

            with self.assertRaisesRegex(ValueError, "Memory content is empty"):
                store.remember("   ")


if __name__ == "__main__":
    unittest.main()
