# Modernization Plan

Kodeks is now Python-only in the active workspace: the default user experience
is served by the Python/FastAPI runtime, and runtime ownership has moved to the
Python OpenAI SDK. Future modernization should stay incremental, with parity
checks before each transition. The TypeScript OpenAI/Agents SDK backend
packages, Next.js shell, pnpm workspace, and TypeScript tooling have been
removed from the active workspace.

## Python Migration Surface Inventory

| Surface            | Current TypeScript owner                                                                 | Python target                                                              | Compatibility contract                                                                                                                                                                                                             | No direct equivalent / risk                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing            | removed Next.js routes and browser fetch helpers                                         | `src/kodeks/app.py`                                                        | Keep existing HTTP paths, status codes, camelCase JSON fields, and SSE event names. The Python-hosted browser UI calls FastAPI routes directly.                                                                                    | Cross-origin browser calls are no longer required for the default UI. CORS is now opt-in through `KODEKS_CORS_ORIGINS` for explicit external shells. |
| Chat stream        | removed `apps/web/src/lib/server/kodeks-runtime.ts`, removed `packages/agent-runtime`    | Python agent loop behind `/api/chat/stream` and `/api/chat/ui`             | Preserve `AgentEvent` SSE frames, UI transport event names, transcript side effects, tool execution, approval-required events, and terminal error handling. Rollback is now branch/release based rather than a Web route fallback. | `@openai/agents` stream events and `openai-agents` Python stream events are not field-for-field identical.                                    |
| Data models        | removed TS storage/runtime types                                                         | Pydantic models in `src/kodeks/contracts.py`                               | Preserve shared SQLite schema, stored JSON shapes, and public camelCase API fields.                                                                                                                                                | Python sync SQLite repositories may differ from TS async repository scheduling under concurrent requests.                                     |
| Auth and safety    | API keys in env/user config, workspace path policy, shell approvals                      | `src/kodeks/config.py`, `workspace.py`, `storage/`                         | No app-user auth is introduced. Keep provider secrets out of `/api/models`, block workspace escapes/internal paths, keep TS-compatible shell argv parsing, and keep dangerous shell commands behind approval plus audit logs.      | Any command parser behavior change needs a characterization test before cutover.                                                              |
| Configuration      | `~/.kodeks/config.json`, `KODEKS_CONFIG_PATH`, `KODEKS_CONFIG_DIR`, env override         | `src/kodeks/config.py`                                                     | User-level config remains the source of truth. Env values keep final precedence. Chat routing is DeepSeek-only and uses MoonBridge as the implicit adapter.                                                                         | Deprecated env aliases and removed direct providers must fail with migration guidance instead of silently changing behavior.                  |
| Build tooling      | removed pnpm workspace, TypeScript, Vitest, ESLint, Prettier, Next build                 | uv, Python 3.11, pytest, ruff, mypy, FastAPI/uvicorn                       | Run Python checks for runtime behavior. Removed TS backend and UI surfaces are covered by Python replacement, repository contract tests, and an offline in-tree package build backend.                                              | Keep the custom build backend narrow; it should only package this pure-Python runtime and static UI assets.                                  |
| Tests              | removed Vitest package tests and route/component tests                                   | pytest contract tests                                                      | Characterization tests describe current behavior first; Python parity tests then match them. Repository contract tests prevent restoring TS/pnpm/Next surfaces.                                                                    | Some loopback bridge tests can fail under sandboxed `listen EPERM`; rerun with local-network permission before treating that as code failure. |
| Deployment/runtime | removed `pnpm dev` and Next-hosted UI                                                    | uvicorn FastAPI service with Python-hosted UI                              | Chat requires Python. The active UI is served at `http://127.0.0.1:8000` by FastAPI. Rollback is the last TS-backed branch/release.                                                                                                | External deployment should now be a Python ASGI deployment instead of a Node app.                                                             |
| External contracts | OpenAI Responses, OpenAI Agents SDK, MoonBridge, DeepSeek Chat Completions, tool schemas | `openai`, `openai-agents`, Python MoonBridge adapter, Python tool registry | Preserve Responses-shaped stream events, terminal `response.failed`, DeepSeek `reasoning_content`, function tool schemas, and secret-free model catalog.                                                                           | Agents SDK interruptions, hosted tools, and strict tool schema behavior need adapter-specific parity tests.                                   |

## Stack Map

| Old stack                           | New stack                                                   | Checkpoint rule                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| removed `packages/model`            | `src/kodeks/config.py` and model client adapter code        | Configuration resolution must pass before any chat runtime cutover.                                                 |
| removed `packages/responses-bridge` | `src/kodeks/providers/bridge.py`                            | Bridge stream parity must pass before Python can handle Chat-Completions-backed models.                             |
| removed `packages/storage`          | `src/kodeks/storage/`                                       | Schema version and stored wire shapes must remain readable by Python runtime and existing local databases.          |
| removed `packages/workspace`        | `src/kodeks/workspace.py`                                   | Path blocking and shell approval decisions must match current policy.                                               |
| removed `packages/tools`            | `src/kodeks/tools/` plus Python handlers                    | Tool definitions, result statuses, approval behavior, and read-only filtering must match before agent-loop cutover. |
| removed `packages/agent-runtime`    | `src/kodeks/runtime.py` plus `src/kodeks/agents_runtime.py` | Preserve `AgentEvent`, transcript side effects, Agents SDK stream event mapping, and tool approvals.                |
| removed Next.js API routes and UI   | FastAPI compatibility routes plus Python-hosted static UI    | Browser clients call Python directly; keep the HTTP paths stable.                                                   |
| removed bridge helper scripts       | `src/kodeks/smoke.py`                                      | Health, model catalog, no-side-effect chat route validation, bridge preflight, and optional live `/v1/responses` smoke checks remain runnable in Python. |

## Milestones

1. Freeze the Python migration contract.
   Keep this inventory current. Add characterization tests for routing, config, bridge, storage, workspace, SSE, and tool schemas. Validate with `uv run pytest`, `uv run ruff check`, and `uv run mypy`.

2. Prove non-chat route parity.
   Finish and verify Python parity for `/api/models`, sessions, approvals, workspace files, and bridge preflight. Validate route-level pytest parity tests.

3. Prove MoonBridge parity.
   Port Responses-to-Chat-Completions behavior fully, including tool call chunking, `reasoning_content`, terminal failures, and `[DONE]`. Validate Python bridge tests and run loopback smoke checks with permission when needed. Rollback is the last TS-backed branch/release.

4. Prove tool and workspace parity.
   Implement Python tool registry handlers for file tools, shell, memory, skills, MCP listing, and subagent boundary behavior. Validate read-only mode filtering, durable approval requests, and matching audit logs. Rollback is the last TS-backed branch/release.

5. Cut the Python agent loop over by default.
   Connect the DeepSeek/MoonBridge runtime to Python tools, storage, memory, and model routing. Preserve `AgentEvent` SSE and UI transport mappings. Keep `KODEKS_FORCE_AGENTS_SDK_RUNTIME=true` as a Python-only Agents SDK diagnostic path. Validate deterministic agent loop tests, focused DeepSeek/MoonBridge adapter tests, lint, type-check, and route tests that require Python.

6. Cut over by default and clean up.
   Make Python the required runtime only after all previous checkpoints pass. Remove TypeScript backend packages, Next.js UI shell, pnpm manifests, and TypeScript tooling after replacement tests exist. Update README, architecture docs, examples, and changelog. Keep the last TS-backed release branch visible until cleanup is complete.

## Current Checkpoint Snapshot

As of 2026-06-02, the repository is in an incremental migration checkpoint:

- The default local path is `uv run kodeks-server --reload`, serving the Python-hosted UI from FastAPI. Installed packages expose the same entrypoint as `kodeks-server`.
- Next.js, pnpm workspaces, TypeScript tooling, and optional TS UI shell files have been removed from the active workspace.
- Browser API clients served by FastAPI call Python routes directly.
- All TypeScript backend/support packages, Web `kodeks-runtime.ts`, local-state fallbacks, Next API shim routes, Next.js UI shell, and old TypeScript bridge script have been removed from the workspace.
- Python currently implements the static UI plus FastAPI compatibility routes for health, models, sessions, workspace files, approvals, bridge preflight, MoonBridge `/v1/responses` plus `/responses`, bridge health/model aliases, `/api/chat/stream`, and `/api/chat/ui`. Chat routes use the DeepSeek/MoonBridge path by default; the Agents SDK path is only available through `KODEKS_FORCE_AGENTS_SDK_RUNTIME=true` for diagnostics.
- Python smoke checks are available through `uv run python -m kodeks.smoke --in-process`; installed packages also expose `kodeks-smoke`. The default smoke set covers health, model catalog, no-side-effect `/api/chat/stream` validation, and bridge preflight. Use `--base-url` for a running server and add `--live-provider` only when provider secrets are configured.
- Python parity tests cover config resolution, secret-free DeepSeek model catalog, implicit MoonBridge routing, route parity, bridge translation, terminal `response.failed`, direct Responses-shaped `error` events, DeepSeek `reasoning_content`, SQLite schema shape and file-DB WAL/busy-timeout setup, parallel file-DB writer connections, workspace path blocking, shell argv parsing, tool schemas, explicit Responses `strict: false` tool defaults, plan-mode read-only filtering, plan artifact creation/recovery, selected workspace file context injection, pre-model memory recall/context injection, large tool output offload to memory artifacts, same-turn tool continuation loops, unknown-tool local halts, multi-turn tool continuation transcript rows, Responses input replay for persisted assistant `output_text`, tool calls, and tool outputs, shell approvals, memory/subagent MVP tools, runtime SSE, UI transport mapping, diagnostic Python `openai-agents` agent construction, dynamic `FunctionTool` schema wrapping, strict schema opt-in, SDK approval metadata, Agents SDK input replay, SDK stream event readers, FastAPI `/api/chat/stream` plus `/api/chat/ui` routing through the DeepSeek/MoonBridge branch, and smoke-check failure reporting for unreachable live providers.
- Remaining migration risk is concentrated in live provider smoke success for the Python `openai-agents` branch, production-scale SQLite write scheduling, and deployment handoff from Node to ASGI. Python package builds are offline-capable through the in-tree PEP 517 backend and gated in CI with `uv build`.

Standard validation for this checkpoint:

```bash
uv run pytest
uv run ruff check
uv run mypy
uv run python evals/run_local.py
uv run python -m kodeks.smoke --in-process
uv build
```

In restricted sandboxes where `uv` cannot use its user cache, set
`UV_CACHE_DIR=.uv-cache` before running `uv build`; the in-tree build backend
does not need network access.

The deterministic agent eval lane also works with `UV_CACHE_DIR=.uv-cache`. It
calls local FastAPI runtime paths with fake model streams and grades the event
trace by OpenAI concept, so it can run in CI without provider credentials. The
optional live lane uses `--live-provider` and the configured model credentials;
run it before concept-oriented refactors and record the pass rate/latency in the
handoff. The live lane is a benchmark, not a CI gate; it may fail when the
selected provider does not reliably emit tool calls.

The smoke harness itself is covered by pytest. Run
`uv run python -m kodeks.smoke --in-process` when local sockets are unavailable,
or `uv run python -m kodeks.smoke --base-url http://127.0.0.1:8000` against a
running server when local sockets are allowed. Add `--live-provider` only when
provider secrets are configured. A failed `live_responses` row means the Python
route and smoke harness ran, but the selected upstream provider was unavailable
or rejected the request.

Notes:

- `uv` may need access to the user-level cache at `~/.cache/uv`.
- Python tests currently emit a Starlette `TestClient` dependency warning from FastAPI's test client stack. Treat that as external dependency churn, not a parity failure.

## Review Gates

- Run focused pytest files for touched Python modules during the pass.
- Run `uv run pytest`, `uv run ruff check`, and `uv run mypy` before a commit-ready handoff.
- Run `uv build` after package metadata or static assets change.
- Update README, architecture notes, or changelogs when user-facing configuration or runtime behavior changes.
- Do not add production dependencies without an explicit dependency review.
- Manually review prompt/runtime guidance, tool schema differences, model selection text, MoonBridge preflight messaging, and strict schema behavior.
