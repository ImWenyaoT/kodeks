"""Regression tests for two P0 fixes found in the pillar audit.

1. Duplicate artifact offload must be idempotent (no UNIQUE(ref_id) crash).
2. UI transport must map plan_artifact events instead of dropping them.
"""

import json

from kodeks.api.ui_transport import to_ui_transport_payload
from kodeks.storage import KodeksDatabase


def test_offload_identical_output_twice_is_idempotent(tmp_path):
    """Re-offloading identical large output reuses the artifact, never crashes."""

    database = KodeksDatabase(":memory:")
    try:
        big = "x" * 200
        first = json.loads(
            database.memories.compact_tool_result(
                workspace_root=str(tmp_path),
                session_id="sess_offload",
                tool_call_id="call_1",
                tool_name="read_file",
                output=big,
                threshold_bytes=10,
            )
        )
        # 同内容第二次卸载（agent 循环常见）：不得抛 IntegrityError。
        second = json.loads(
            database.memories.compact_tool_result(
                workspace_root=str(tmp_path),
                session_id="sess_offload",
                tool_call_id="call_2",
                tool_name="read_file",
                output=big,
                threshold_bytes=10,
            )
        )
        assert first["offloaded"] is True
        assert second["offloaded"] is True
        assert first["refId"] == second["refId"]
        rows = database.connection.execute(
            "SELECT COUNT(*) AS n FROM memory_artifacts WHERE ref_id = ?",
            (first["refId"],),
        ).fetchone()
        assert rows["n"] == 1
        # refId 仍可回读（复用的记录指向同一文件）。
        recovered = database.memories.read_artifact_content(first["refId"])
        assert recovered is not None
        assert big in recovered["content"]
    finally:
        database.close()


def test_ui_transport_maps_plan_artifact():
    """plan_artifact runtime events survive the UI transport adapter."""

    payload = to_ui_transport_payload(
        {
            "type": "plan_artifact",
            "action": "created",
            "plan": {"title": "Storage plan", "steps": []},
            "session_id": "sess_plan",
        }
    )

    assert payload is not None
    assert payload["type"] == "plan"
    assert payload["action"] == "created"
    assert payload["plan"] == {"title": "Storage plan", "steps": []}
    assert payload["sessionId"] == "sess_plan"
