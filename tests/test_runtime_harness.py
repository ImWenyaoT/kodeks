import json

import pytest

from kodeks.harness import select_harness_pattern
from kodeks.runtime import run_python_chat_turn
from kodeks.storage import KodeksDatabase


@pytest.mark.asyncio
async def test_python_chat_loop_injects_harness_pattern_and_audit(tmp_path):
    """Runtime context records why a bounded harness pattern was selected."""

    seen_bodies = []

    def responses_events(body, env):
        seen_bodies.append(body)
        return [{"type": "response.completed", "response": {"id": "resp_harness"}}]

    database = KodeksDatabase(":memory:")
    try:
        _events = [
            event
            async for event in run_python_chat_turn(
                {
                    "input": "Verify every technical claim against the codebase.",
                    "session_id": "sess_harness",
                    "mode": "plan",
                },
                database,
                str(tmp_path),
                {},
                responses_events,
            )
        ]
        payload = json.loads(
            database.connection.execute(
                "SELECT payload_json FROM audit_log WHERE event_type = 'harness_pattern_selected'"
            ).fetchone()["payload_json"]
        )

        assert payload["pattern"] == "adversarial_verify"
        assert "self_preferential_bias" in payload["failureModes"]
        assert "Harness pattern for this turn: adversarial_verify." in seen_bodies[0][
            "instructions"
        ]
        assert "claim, evidence, risk, confidence, and nextAction" in seen_bodies[0][
            "instructions"
        ]
    finally:
        database.close()


def test_harness_pattern_selection_keeps_workflows_bounded():
    """Harness pattern selection maps complex asks to a small fixed set."""

    loop = select_harness_pattern(
        "This test fails maybe 1 in 50 runs; don't stop until one theory works.",
        "act",
    )
    verify = select_harness_pattern(
        "Verify every technical claim against the codebase.", "plan"
    )
    tournament = select_harness_pattern(
        "I need a name for this CLI tool; run a tournament for the top 3.", "plan"
    )
    fanout = select_harness_pattern(
        "Use a workflow to rename our User model to Account everywhere.", "plan"
    )

    assert loop.pattern == "loop_until_done"
    assert verify.pattern == "adversarial_verify"
    assert tournament.pattern == "tournament"
    assert fanout.pattern == "fanout_synthesize"
    assert "Subagents are read-only" in loop.approval_boundary
    assert set(loop.subagent_contract) == {
        "claim",
        "evidence",
        "risk",
        "confidence",
        "nextAction",
    }
