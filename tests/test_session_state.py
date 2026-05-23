import inspect
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from kodeks.runtime.session_state import InMemorySessionStateStore, SQLiteSessionStateStore


class InMemorySessionStateStoreTest(unittest.IsolatedAsyncioTestCase):
    async def test_store_get_set_clear_and_overwrite(self) -> None:
        """Verify the in-memory session store keeps only the latest response ID."""

        store = InMemorySessionStateStore()

        self.assertIsNone(await store.get_previous_response_id("s1"))

        await store.set_previous_response_id("s1", "resp_1")
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_1")

        await store.set_previous_response_id("s1", "resp_2")
        self.assertEqual(await store.get_previous_response_id("s1"), "resp_2")

        await store.append_transcript_event("s1", "user", "hello")
        await store.append_transcript_event("s1", "assistant", "hi")
        self.assertEqual(
            await store.get_transcript("s1"),
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"},
            ],
        )

        await store.clear("s1")
        self.assertIsNone(await store.get_previous_response_id("s1"))
        self.assertEqual(await store.get_transcript("s1"), [])


class SQLiteSessionStateStoreTest(unittest.IsolatedAsyncioTestCase):
    def test_store_methods_are_async(self) -> None:
        """Verify SQLite database access exposes async/await methods."""

        self.assertTrue(inspect.iscoroutinefunction(SQLiteSessionStateStore.get_previous_response_id))
        self.assertTrue(inspect.iscoroutinefunction(SQLiteSessionStateStore.set_previous_response_id))
        self.assertTrue(inspect.iscoroutinefunction(SQLiteSessionStateStore.clear))
        self.assertTrue(inspect.iscoroutinefunction(SQLiteSessionStateStore.append_transcript_event))
        self.assertTrue(inspect.iscoroutinefunction(SQLiteSessionStateStore.get_transcript))

    async def test_store_persists_across_instances(self) -> None:
        """Verify the SQLite store keeps session state across store instances."""

        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "session_state.sqlite3"
            first_store = SQLiteSessionStateStore(db_path)

            self.assertIsNone(await first_store.get_previous_response_id("s1"))

            await first_store.set_previous_response_id("s1", "resp_1")
            second_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(await second_store.get_previous_response_id("s1"), "resp_1")

            await second_store.set_previous_response_id("s1", "resp_2")
            third_store = SQLiteSessionStateStore(db_path)
            self.assertEqual(await third_store.get_previous_response_id("s1"), "resp_2")

            await third_store.clear("s1")
            self.assertIsNone(await SQLiteSessionStateStore(db_path).get_previous_response_id("s1"))

    async def test_store_persists_transcript_across_instances(self) -> None:
        """Verify SQLite session state stores a minimal transcript for resume."""

        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "session_state.sqlite3"
            first_store = SQLiteSessionStateStore(db_path)
            await first_store.append_transcript_event("s1", "user", "hello")
            await first_store.append_transcript_event("s1", "assistant", "hi")

            second_store = SQLiteSessionStateStore(db_path)
            transcript = await second_store.get_transcript("s1")

        self.assertEqual(
            transcript,
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi"},
            ],
        )

    async def test_schema_initializes_once_per_store_instance(self) -> None:
        """Verify SQLite schema setup is not repeated on every store operation."""

        with TemporaryDirectory() as tmp_dir:
            store = SQLiteSessionStateStore(Path(tmp_dir) / "session_state.sqlite3")
            with patch.object(
                store,
                "_ensure_schema_sync",
                wraps=store._ensure_schema_sync,
            ) as ensure_schema:
                await store.set_previous_response_id("s1", "resp_1")
                await store.get_previous_response_id("s1")
                await store.clear("s1")

        self.assertEqual(ensure_schema.call_count, 1)

    async def test_sqlite_connection_is_reused_per_store_instance(self) -> None:
        """Verify SQLite operations reuse one connection instead of reconnecting per call."""

        with TemporaryDirectory() as tmp_dir:
            store = SQLiteSessionStateStore(Path(tmp_dir) / "session_state.sqlite3")
            with patch(
                "kodeks.runtime.session_state.sqlite3.connect",
                wraps=sqlite3.connect,
            ) as connect:
                await store.set_previous_response_id("s1", "resp_1")
                await store.get_previous_response_id("s1")
                await store.clear("s1")

        self.assertEqual(connect.call_count, 1)


if __name__ == "__main__":
    unittest.main()
