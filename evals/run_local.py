"""Run deterministic local evals against the Kodeks agent runtime."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from kodeks.app import create_app
from kodeks.storage import KodeksDatabase

Case = dict[str, Any]
Event = dict[str, Any]


@dataclass
class EvalEvidence:
    """Evidence captured from one app-backed eval case."""

    events: list[Event] = field(default_factory=list)
    response_json: dict[str, Any] | None = None
    status_code: int | None = None
    duration_ms: float = 0.0
    model_bodies: list[dict[str, Any]] = field(default_factory=list)
    agent_tools: list[str] = field(default_factory=list)


@dataclass
class EvalResult:
    """Result payload for one evaluated case."""

    id: str
    lane: str
    concept: str
    passed: bool
    failures: list[str]
    evidence: EvalEvidence


class FakeAgentsSdkResult:
    """Minimal streaming result used to avoid live provider calls in evals."""

    def __init__(
        self,
        events: list[dict[str, Any]],
        final_output: str = "eval final",
        last_response_id: str = "resp_eval",
    ) -> None:
        self.events = events
        self.final_output = final_output
        self.last_response_id = last_response_id
        self.interruptions: list[Any] = []

    async def stream_events(self) -> AsyncIterator[object]:
        """Yield deterministic Agents SDK stream events."""

        for event in self.events:
            yield event


class EvalAgentsSdkRunner:
    """Capture Agents SDK tool surfaces and return deterministic events."""

    def __init__(self, scenario: str, evidence: EvalEvidence) -> None:
        self.scenario = scenario
        self.evidence = evidence

    def run_streamed(
        self, starting_agent: Any, input: list[dict[str, Any]], **kwargs: Any
    ) -> FakeAgentsSdkResult:
        """Record agent tools and return a case-specific fake stream."""

        self.evidence.agent_tools = [tool.name for tool in starting_agent.tools]
        if self.scenario == "agents_sdk_approval":
            return FakeAgentsSdkResult(
                [
                    {
                        "type": "run_item_stream_event",
                        "name": "tool_approval_requested",
                        "item": {"rawItem": {"call_id": "call_shell"}},
                    }
                ]
            )
        return FakeAgentsSdkResult(
            [
                {
                    "type": "raw_model_stream_event",
                    "data": {"type": "output_text_delta", "delta": "eval"},
                },
                {
                    "type": "raw_model_stream_event",
                    "data": {"type": "output_text_delta", "delta": " final"},
                },
            ]
        )


class ScriptedResponsesFactory:
    """Return deterministic Responses-shaped events for local eval scenarios."""

    def __init__(self, scenario: str, evidence: EvalEvidence) -> None:
        self.scenario = scenario
        self.evidence = evidence

    def __call__(
        self, body: Mapping[str, Any], env: Mapping[str, str | None]
    ) -> list[dict[str, Any]]:
        """Capture model body and return scripted model events."""

        captured = dict(body)
        self.evidence.model_bodies.append(captured)
        if self.scenario == "read_file_tool_loop":
            if _has_function_call_output(captured):
                return _final_text_events("Read complete.", "resp_read_final")
            return [
                {"type": "response.output_text.delta", "delta": "Reading..."},
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call_read",
                        "name": "read_file",
                        "arguments": json.dumps({"path": "README.md"}),
                    },
                },
                {
                    "type": "response.completed",
                    "response": {"id": "resp_read_tool", "status": "completed"},
                },
            ]
        if self.scenario == "dangerous_shell_approval":
            return [
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call_shell",
                        "name": "run_shell",
                        "arguments": json.dumps({"command": "rm -rf output"}),
                    },
                },
                {
                    "type": "response.completed",
                    "response": {"id": "resp_approval", "status": "completed"},
                },
            ]
        if self.scenario == "unknown_tool":
            return [
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call_missing",
                        "name": "missing_tool",
                        "arguments": "{}",
                    },
                },
                {
                    "type": "response.completed",
                    "response": {"id": "resp_unknown", "status": "completed"},
                },
            ]
        if self.scenario == "large_tool_artifact":
            if _has_function_call_output(captured):
                return _final_text_events("Artifact stored.", "resp_large_final")
            return [
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": "call_large",
                        "name": "read_file",
                        "arguments": json.dumps({"path": "large.txt"}),
                    },
                },
                {
                    "type": "response.completed",
                    "response": {"id": "resp_large_tool", "status": "completed"},
                },
            ]
        if self.scenario == "plan_artifact":
            return _final_text_events(
                "# Eval plan\n\nAdd deterministic eval coverage.\n\n1. Add cases\n2. Run the benchmark",
                "resp_plan",
            )
        return _final_text_events("Done.", "resp_final")


def main(argv: Sequence[str] | None = None) -> int:
    """Run the local eval suite and write a machine-readable result file."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default="evals/cases.jsonl")
    parser.add_argument("--live-cases", default="evals/live_cases.jsonl")
    parser.add_argument(
        "--live-provider",
        action="store_true",
        help="Run live provider eval cases using configured model credentials.",
    )
    parser.add_argument("--output", default="evals/results/latest.json")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    cases = load_cases(Path(args.cases))
    if args.live_provider:
        cases.extend(load_cases(Path(args.live_cases)))
    results = [run_case(case) for case in cases]
    summary = summarize_results(results)
    payload = {
        "summary": summary,
        "results": [result_to_json(result) for result in results],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n")
    if not args.quiet:
        print_summary(summary, results)
    return 0 if summary["failed"] == 0 else 1


def load_cases(path: Path) -> list[Case]:
    """Load JSONL eval cases from disk."""

    cases: list[Case] = []
    for line_number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        parsed = json.loads(line)
        if not isinstance(parsed, dict):
            raise ValueError(f"Case line {line_number} must be a JSON object.")
        cases.append(parsed)
    return cases


def run_case(case: Case) -> EvalResult:
    """Run one case against a temporary app workspace."""

    evidence = EvalEvidence()
    with tempfile.TemporaryDirectory(prefix=f"kodeks-eval-{case['id']}-") as root:
        workspace = Path(root)
        db_path = workspace / ".kodeks" / "kodeks.sqlite3"
        write_fixtures(workspace, case.get("fixtures") or {})
        seed_database(db_path, case.get("seed_memories") or [])
        env = {
            "KODEKS_WORKSPACE_ROOT": str(workspace),
            "KODEKS_DB_PATH": str(db_path),
            **dict(case.get("env") or {}),
        }
        runtime = case.get("runtime")
        if runtime != "live_provider":
            env["KODEKS_CONFIG_PATH"] = str(workspace / "missing-config.json")
        if runtime == "agents_sdk":
            env.update(
                {
                    "KODEKS_FORCE_AGENTS_SDK_RUNTIME": "true",
                    "KODEKS_MODEL_PROVIDER": "moonbridge",
                    "KODEKS_CHAT_COMPLETIONS_API_KEY": "sk-eval",
                    "KODEKS_CHAT_COMPLETIONS_MODEL": "deepseek-v4-pro",
                }
            )
        scenario = str(case.get("scenario") or "final_text")
        route = str(case.get("route") or "chat_stream")
        with patched_environ(env):
            started_at = time.perf_counter()
            if route == "bridge_preflight":
                run_bridge_case(case, evidence)
            elif runtime == "live_provider":
                run_live_provider_case(case, evidence, route)
            elif runtime == "agents_sdk":
                run_agents_sdk_case(case, scenario, evidence, route)
            else:
                run_responses_case(case, scenario, evidence, route)
            evidence.duration_ms = (time.perf_counter() - started_at) * 1000
    failures = grade_case(case, evidence)
    return EvalResult(
        id=str(case["id"]),
        lane=str(case.get("lane") or ("live" if case.get("runtime") == "live_provider" else "deterministic")),
        concept=str(case.get("concept") or "uncategorized"),
        passed=not failures,
        failures=failures,
        evidence=evidence,
    )


def write_fixtures(workspace: Path, fixtures: Mapping[str, str]) -> None:
    """Write case fixture files into the temporary workspace."""

    for relative_path, content in fixtures.items():
        path = workspace / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def seed_database(db_path: Path, memories: list[dict[str, Any]]) -> None:
    """Seed durable memory rows before the app handles a case."""

    db = KodeksDatabase(str(db_path))
    try:
        for memory in memories:
            content = memory.get("content")
            if isinstance(content, str):
                db.memories.remember(str(memory.get("scope") or "project"), content)
    finally:
        db.close()


def run_responses_case(
    case: Case, scenario: str, evidence: EvalEvidence, route: str
) -> None:
    """Run a case through the direct Responses diagnostic path."""

    app = create_app(responses_event_factory=ScriptedResponsesFactory(scenario, evidence))
    client = TestClient(app)
    path = "/api/chat/ui" if route == "chat_ui" else "/api/chat/stream"
    response = client.post(path, json=chat_payload(case))
    evidence.status_code = response.status_code
    evidence.events = parse_sse_events(response.text)


def run_agents_sdk_case(
    case: Case, scenario: str, evidence: EvalEvidence, route: str
) -> None:
    """Run a case through the default Agents SDK app branch."""

    app = create_app(agents_runner=EvalAgentsSdkRunner(scenario, evidence))
    client = TestClient(app)
    path = "/api/chat/ui" if route == "chat_ui" else "/api/chat/stream"
    response = client.post(path, json=chat_payload(case))
    evidence.status_code = response.status_code
    evidence.events = parse_sse_events(response.text)


def run_live_provider_case(case: Case, evidence: EvalEvidence, route: str) -> None:
    """Run a case through the real configured provider path."""

    client = TestClient(create_app())
    path = "/api/chat/ui" if route == "chat_ui" else "/api/chat/stream"
    response = client.post(path, json=chat_payload(case))
    evidence.status_code = response.status_code
    evidence.events = parse_sse_events(response.text)


def run_bridge_case(case: Case, evidence: EvalEvidence) -> None:
    """Run a route-level bridge diagnostic case."""

    client = TestClient(create_app())
    response = client.post("/api/bridge/preflight", json=chat_payload(case))
    evidence.status_code = response.status_code
    parsed = response.json()
    evidence.response_json = parsed if isinstance(parsed, dict) else {}


def chat_payload(case: Case) -> dict[str, Any]:
    """Build the JSON body sent to the app route."""

    payload = {
        "input": case.get("prompt") or "",
        "session_id": f"eval_{case['id']}",
        "mode": case.get("mode") or "act",
    }
    for key in ("model", "provider", "reasoning_effort"):
        if isinstance(case.get(key), str):
            payload[key] = case[key]
    return payload


def parse_sse_events(text: str) -> list[Event]:
    """Parse a simple Server-Sent Events response into event dictionaries."""

    events: list[Event] = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        name = ""
        data_lines: list[str] = []
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ").strip()
            elif line.startswith("data: "):
                data_lines.append(line.removeprefix("data: "))
        if not data_lines:
            continue
        payload = json.loads("\n".join(data_lines))
        if isinstance(payload, dict):
            payload.setdefault("type", name)
            events.append(payload)
    return events


def grade_case(case: Case, evidence: EvalEvidence) -> list[str]:
    """Evaluate all assertions for one case."""

    failures: list[str] = []
    for assertion in case.get("assertions") or []:
        if not isinstance(assertion, dict):
            failures.append("Assertion must be an object.")
            continue
        message = check_assertion(assertion, evidence)
        if message is not None:
            failures.append(message)
    return failures


def check_assertion(
    assertion: Mapping[str, Any], evidence: EvalEvidence
) -> str | None:
    """Return a failure message when an assertion does not hold."""

    assertion_type = assertion.get("type")
    if assertion_type == "event_present":
        event = str(assertion["event"])
        return None if any(item.get("type") == event for item in evidence.events) else f"Missing event {event}."
    if assertion_type == "event_absent":
        event = str(assertion["event"])
        return None if all(item.get("type") != event for item in evidence.events) else f"Unexpected event {event}."
    if assertion_type == "tool_called":
        tool = str(assertion["tool"])
        return None if any(item.get("type") == "tool_call" and item.get("tool_name") == tool for item in evidence.events) else f"Missing tool call {tool}."
    if assertion_type == "tool_status":
        tool = str(assertion["tool"])
        status = str(assertion["status"])
        return None if any(item.get("type") == "tool_result" and item.get("tool_name") == tool and item.get("tool_status") == status for item in evidence.events) else f"Missing tool result {tool}={status}."
    if assertion_type == "error_code":
        code = str(assertion["code"])
        return None if any(item.get("type") == "error" and item.get("code") == code for item in evidence.events) else f"Missing error code {code}."
    if assertion_type == "tool_output_json_path":
        return check_tool_output_json_path(assertion, evidence)
    if assertion_type == "text_delta_min_chars":
        minimum = int(assertion["minimum"])
        text = "".join(
            str(event.get("delta") or "")
            for event in evidence.events
            if event.get("type") in {"text_delta", "text-delta"}
        )
        return None if len(text) >= minimum else f"Text delta length {len(text)} < {minimum}."
    if assertion_type == "model_instructions_contain":
        text = str(assertion["text"])
        return None if any(text in str(body.get("instructions") or "") for body in evidence.model_bodies) else f"Model instructions did not contain {text!r}."
    if assertion_type == "plan_title":
        expected = assertion.get("equals")
        return None if any(item.get("type") == "plan_artifact" and _path(item, ["plan", "title"]) == expected for item in evidence.events) else f"Missing plan title {expected!r}."
    if assertion_type == "agent_tool_present":
        tool = str(assertion["tool"])
        return None if tool in evidence.agent_tools else f"Agent tool {tool} was not exposed."
    if assertion_type == "agent_tool_absent":
        tool = str(assertion["tool"])
        return None if tool not in evidence.agent_tools else f"Agent tool {tool} was unexpectedly exposed."
    if assertion_type == "http_status":
        status = int(assertion["status"])
        return None if evidence.status_code == status else f"HTTP status {evidence.status_code} != {status}."
    if assertion_type == "response_json_path":
        expected = assertion.get("equals")
        actual = _path(evidence.response_json or {}, list(assertion.get("path") or []))
        return None if actual == expected else f"JSON path {assertion.get('path')} was {actual!r}, expected {expected!r}."
    return f"Unknown assertion type: {assertion_type}."


def check_tool_output_json_path(
    assertion: Mapping[str, Any], evidence: EvalEvidence
) -> str | None:
    """Check the first tool_result JSON output for a nested path."""

    for event in evidence.events:
        if event.get("type") != "tool_result":
            continue
        raw_output = event.get("tool_output")
        if not isinstance(raw_output, str):
            continue
        try:
            parsed = json.loads(raw_output)
        except json.JSONDecodeError:
            continue
        actual = _path(parsed, list(assertion.get("path") or []))
        if assertion.get("exists") is True and actual is not None:
            return None
        if "equals" in assertion and actual == assertion.get("equals"):
            return None
    return f"No tool output matched JSON path assertion {assertion}."


def summarize_results(results: list[EvalResult]) -> dict[str, Any]:
    """Build aggregate benchmark metrics grouped by OpenAI concept."""

    concept_totals: dict[str, dict[str, int]] = {}
    lane_totals: dict[str, dict[str, int]] = {}
    for result in results:
        bucket = concept_totals.setdefault(result.concept, {"passed": 0, "total": 0})
        bucket["total"] += 1
        bucket["passed"] += 1 if result.passed else 0
        lane_bucket = lane_totals.setdefault(result.lane, {"passed": 0, "total": 0})
        lane_bucket["total"] += 1
        lane_bucket["passed"] += 1 if result.passed else 0
    total = len(results)
    passed = sum(1 for result in results if result.passed)
    return {
        "passed": passed,
        "failed": total - passed,
        "total": total,
        "passRate": passed / total if total else 0.0,
        "concepts": {
            concept: {
                **counts,
                "passRate": counts["passed"] / counts["total"]
                if counts["total"]
                else 0.0,
            }
            for concept, counts in sorted(concept_totals.items())
        },
        "lanes": {
            lane: {
                **counts,
                "passRate": counts["passed"] / counts["total"]
                if counts["total"]
                else 0.0,
            }
            for lane, counts in sorted(lane_totals.items())
        },
    }


def result_to_json(result: EvalResult) -> dict[str, Any]:
    """Serialize one eval result without leaking temporary workspace paths."""

    return {
        "id": result.id,
        "lane": result.lane,
        "concept": result.concept,
        "passed": result.passed,
        "failures": result.failures,
        "durationMs": round(result.evidence.duration_ms, 2),
        "events": [
            {
                key: value
                for key, value in event.items()
                if key
                in {"type", "tool_name", "tool_status", "code", "delta", "message"}
            }
            for event in result.evidence.events
        ],
        "agentTools": result.evidence.agent_tools,
        "statusCode": result.evidence.status_code,
        "responseJson": result.evidence.response_json,
    }


def print_summary(summary: Mapping[str, Any], results: list[EvalResult]) -> None:
    """Print a compact scoreboard suitable for local development."""

    print(
        f"Kodeks evals: {summary['passed']}/{summary['total']} passed "
        f"({summary['passRate']:.0%})"
    )
    for concept, counts in summary["concepts"].items():
        print(f"- {concept}: {counts['passed']}/{counts['total']} ({counts['passRate']:.0%})")
    print("Lanes:")
    for lane, counts in summary["lanes"].items():
        print(f"- {lane}: {counts['passed']}/{counts['total']} ({counts['passRate']:.0%})")
    failed = [result for result in results if not result.passed]
    if failed:
        print("\nFailures:")
        for result in failed:
            print(f"- {result.id}: {'; '.join(result.failures)}")


def _final_text_events(text: str, response_id: str) -> list[dict[str, Any]]:
    """Build a deterministic final-text Responses event sequence."""

    return [
        {"type": "response.output_text.delta", "delta": text},
        {"type": "response.completed", "response": {"id": response_id}},
    ]


def _has_function_call_output(body: Mapping[str, Any]) -> bool:
    """Return whether the replayed Responses input contains tool output."""

    value = body.get("input")
    return isinstance(value, list) and any(
        isinstance(item, dict) and item.get("type") == "function_call_output"
        for item in value
    )


def _path(value: Any, path: list[Any]) -> Any:
    """Read a nested dictionary path."""

    current = value
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


@contextmanager
def patched_environ(values: Mapping[str, str]) -> Iterator[None]:
    """Temporarily patch process environment variables."""

    previous = {key: os.environ.get(key) for key in values}
    try:
        os.environ.update(values)
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value


if __name__ == "__main__":
    raise SystemExit(main())
