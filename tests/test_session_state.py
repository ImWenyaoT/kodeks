import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from kodeks.runtime.session_state import InMemorySessionStateStore, SQLiteSessionStateStore


class InMemorySessionStateStoreTest(unittest.TestCase):
    def test_store_get_set_clear_and_overwrite(self) -> None:
        """Verify the in-memory session store keeps only the latest response ID."""

        store = InMemorySessionStateStore()

        self.assertIsNone(store.get_previous_response_id("s1"))

        store.set_previous_response_id("s1", "resp_1")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_1")

        store.set_previous_response_id("s1", "resp_2")
        self.assertEqual(store.get_previous_response_id("s1"), "resp_2")

        store.clear("s1")
        self.assertIsNone(store.get_previous_response_id("s1"))


class SQLiteSessionStateStoreTest(unittest.TestCase):
    def test_store_persists_across_instances(self) -> None:
        """Verify the SQLite store keeps session state across store instances."""

        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "session_state.sqlite3"
            first_store = SQLiteSessionStateStore(db_path)

            self.assertIsNone(first_store.get_previous_response_id("s1"))

            first_store.set_previous_response_id("s1", "resp_1")
            second_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(second_store.get_previous_response_id("s1"), "resp_1")

            second_store.set_previous_response_id("s1", "resp_2")
            third_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(third_store.get_previous_response_id("s1"), "resp_2")

            third_store.clear("s1")
            self.assertIsNone(SQLiteSessionStateStore(db_path).get_previous_response_id("s1"))


if __name__ == "__main__":
    unittest.main()
