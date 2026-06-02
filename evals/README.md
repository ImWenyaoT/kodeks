# Kodeks Agent Evals

This directory contains the first local benchmark for the Kodeks coding-agent
harness. It is intentionally deterministic: cases exercise the FastAPI runtime
paths without requiring provider credentials, then grade the event trace and
runtime side effects.

Run:

```bash
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py --live-provider
```

The runner writes `evals/results/latest.json` and exits non-zero when any case
fails.

## Evaluation Shape

- `cases.jsonl` maps deterministic cases to an OpenAI concept such as
  tools/function calling, conversation state, context management, planning,
  model routing, or Agents SDK tool surfaces.
- `live_cases.jsonl` maps optional real-provider cases to the same concept
  taxonomy. The live lane uses the configured model credentials and temporary
  workspaces.
- `run_local.py` calls the same app routes users hit: `/api/chat/stream`,
  `/api/chat/ui`, and selected diagnostics such as `/api/bridge/preflight`.
- Assertions grade event traces and observable JSON payloads instead of exact
  prose, so the benchmark stays stable across model copy changes.

## Reading The Score

The most useful interview-facing metric is concept coverage plus pass rate:

```text
overall pass rate = passed cases / total cases
concept pass rate = passed cases for a concept / cases for that concept
```

Use the local deterministic lane as the regression baseline. Use
`--live-provider` before concept-oriented refactors or demos that need a
provider-facing benchmark. Treat live latency and pass rate as useful evidence,
but keep deterministic results as the CI gate.
