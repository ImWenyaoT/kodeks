# Kodeks evals

This directory holds reliability-oriented eval inputs and result snapshots.

## Deterministic results

`results/latest.json` is the deterministic harness summary. It should stay fast,
offline, and safe for CI-style inspection.

## Live coding-agent evals

`live-coding-tasks.json` contains 63 small, dependency-free JavaScript repair
tasks. The live runner creates a temporary workspace, asks a running Kodeks
server to fix each case through `/api/chat/stream`, parses the SSE runtime
events, then verifies the final workspace with a plain argv command.

Run from `frontend/` after starting Kodeks with a real model provider and the
same workspace path used by the runner:

```bash
KODEKS_WORKSPACE_ROOT=../evals/workspace-live npm run dev
npm run eval:live -- --limit 5
```

Useful options:

- `--base-url <url>`: Kodeks server URL.
- `--case <id>`: run one case.
- `--control-token <tok>`: send `Authorization: Bearer <tok>` for protected
  control APIs. The runner also reads `KODEKS_EVAL_CONTROL_TOKEN` and
  `KODEKS_CONTROL_TOKEN`.
- `--limit <n>`: run the first `n` selected cases.
- `--workspace <path>`: reuse a workspace path. Start Kodeks with the same path
  as `KODEKS_WORKSPACE_ROOT`.
- `--reset-workspace`: delete the selected workspace before materializing cases.
  This is automatic only for the default `evals/workspace-live` directory.
- `--keep-workspace`: keep the generated workspace for inspection.

The output is written to `evals/results/live-latest.json` by default and records
pass rate, per-concept pass rate, tool call counts, approval counts, runtime
errors, protected test-file tampering, verifier exit codes, and bounded
stdout/stderr.

## Release gate

`frontend/` exposes an offline result checker:

```bash
npm run eval:live:check
```

The checker fails closed when `evals/results/live-latest.json` is missing, stale
(older than 72 hours by default), not aligned with the manifest, below the pass
threshold, or contains runtime errors / protected verifier edits. `npm run
release:check` chains unit tests, lint, typecheck, build, and this live eval
result gate.

The strict defaults can be adjusted only with explicit release environment
variables:

- `KODEKS_LIVE_EVAL_RESULTS`
- `KODEKS_LIVE_EVAL_MAX_AGE_HOURS`
- `KODEKS_LIVE_EVAL_MIN_PASS_RATE`
- `KODEKS_LIVE_EVAL_MIN_CONCEPT_PASS_RATE`
