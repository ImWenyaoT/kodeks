# kodeks

**kodeks** is a local-first coding agent workbench. Its scope is intentionally
small: a coding agent with memory, multi-session state, subagent exploration,
plan mode, workspace tools, human approval, and a protocol adapter for
OpenAI-compatible Chat Completions, with DeepSeek as the default upstream.

> **Runtime: TypeScript / Next.js.** kodeks was migrated from its original
> Python/FastAPI backend to a single Next.js full-stack app (App Router route
> handlers + `frontend/lib/server`). Behavior parity with the Python original is
> pinned by byte-level golden fixtures under [`oracle/`](./oracle/README.md). The
> Python sources have been retired; see git history if you need them.

[中文 README](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Deploy](./frontend/DEPLOY.md) · [Oracle fixtures](./oracle/README.md)

## Product Boundary

Kodeks is not a generic agent platform. It does not aim to provide web search,
a provider dashboard, a plugin marketplace, or a broad hosted-agent surface.
The point of the codebase is to show a compact but serious harness around an
LLM:

- state management for sessions, transcript replay, plans, memory, artifacts,
  approvals, and subagent run records;
- flow control for streaming turns, tool calls, tool-result continuation,
  plan-mode read-only filtering, and terminal errors;
- human approval for risky shell execution, with durable decisions and audit
  events;
- observability through SSE runtime events and audit logs;
- multi-agent shape through read-only subagent exploration and persisted
  summaries;
- protocol integration through a Responses-shaped runtime contract and
  MoonBridge conversion to OpenAI-compatible Chat Completions.

The design center is harness understanding: context assembly, tools,
permissions, state, protocol shape, and evaluation.

## Architecture

A single Next.js application. The browser UI (React 19 + Tailwind v4 + shadcn/ui
+ Zustand) and the backend runtime live in the same `frontend/` app and talk
over same-origin `fetch`.

```
frontend/
  app/                       Next.js App Router
    page.tsx, layout.tsx     React UI (unchanged through the migration)
    api/**/route.ts          HTTP route handlers (Node runtime), thin wrappers
  lib/server/                the backend runtime (migrated from Python)
    wire/                    SSE framing + runtime/UI event contracts (Zod)
    bridge/                  MoonBridge: Responses <-> Chat Completions (DeepSeek)
    config.ts, model-config  env / dotenv / model catalog / provider resolution
    storage/                 libSQL repositories (sessions/memory/approvals/plan/...)
    tools/                   9 model tools + registry (read/write/grep/run_shell/...)
    workspace.ts             path sandbox + dangerous-command policy + argv exec
    agent/                   the turn loop, tool continuation, context assembly, harness
    routes/                  injectable route logic (chat/sessions/approvals/...)
    execution/               command executor (local / Vercel Sandbox)
oracle/                      golden behavior fixtures (see oracle/README.md)
```

The model upstream is reached **in-process**: the runtime calls the bridge
directly (`fromDeepseekStream(fetchChatCompletionsStream(toDeepseekChatRequest(...)))`),
no self HTTP hop. The default upstream is DeepSeek via MoonBridge.

## Quick Start

```bash
cd frontend
npm install
```

Provide DeepSeek credentials in `frontend/.env.local` (Next.js loads it
automatically):

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

Run the dev server and open `http://localhost:3000`:

```bash
npm run dev
```

Health check and an SSE chat stream:

```bash
curl http://localhost:3000/health
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required: an OpenAI-compatible Chat Completions API key, routed through
MoonBridge. DeepSeek is the default upstream.

Configuration precedence is:

1. Explicit process environment variables
2. Project `.env` (workspace-root `.env`, when `KODEKS_WORKSPACE_ROOT` is set)
3. Structured config files (`.kodeks/config.json`, then `~/.kodeks/config.json`)

Common options:

- `API_KEY` / `DEEPSEEK_API_KEY` → `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `BASE_URL` / `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`)
- `MODEL` / `DEEPSEEK_MODEL` (default `deepseek-v4-pro`; catalog includes
  `deepseek-v4-pro` and `deepseek-v4-flash`)
- `KODEKS_BRIDGE_REASONING_EFFORT` ∈ `none|low|medium|high|xhigh`
- `KODEKS_WORKSPACE_ROOT`, `KODEKS_DB_PATH`

Persistence: a local libSQL file under `.kodeks/kodeks.sqlite3` by default. For
serverless/production, set `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) for the
database, `BLOB_READ_WRITE_TOKEN` for large memory artifacts (Vercel Blob), and
deploy on Vercel — see [`frontend/DEPLOY.md`](./frontend/DEPLOY.md).

## MoonBridge

MoonBridge is an internal protocol adapter (`frontend/lib/server/bridge/`). The
runtime keeps a Responses-shaped contract while routing an OpenAI-compatible
Chat Completions upstream (DeepSeek by default). It converts the request
(`instructions`/`input`/`tools`/`reasoning.effort`) and maps the streamed
`chat.completion.chunk` responses back to Responses events, preserving DeepSeek
`reasoning_content` on tool-call turns.

## Development

All checks run from `frontend/`:

```bash
cd frontend
npm test            # vitest (incl. oracle replay)
npm run lint        # eslint
npx tsc --noEmit    # typecheck
npm run build       # next build
npm run eval:live   # live model eval runner (requires a running Kodeks server)
npm run release:check # test + lint + typecheck + build + live eval result gate
```

CI runs the deterministic gates (`.github/workflows/ci.yml`). Releases should
also pass `npm run release:check` with a fresh live eval result.

### Behavior parity (oracle)

[`oracle/`](./oracle/README.md) holds golden behavior snapshots recorded from
the original Python backend (event sequences, byte-exact SSE, audit rows) across
10 scenarios. The TS tests replay them and assert byte-for-byte equivalence —
this is how the migration proves the new runtime behaves identically to the old.

### Live eval

[`evals/live-coding-tasks.json`](./evals/live-coding-tasks.json) provides 63
small real repair tasks. Start Kodeks against the same workspace used by the
runner, then execute a sample:

```bash
cd frontend
KODEKS_WORKSPACE_ROOT=../evals/workspace-live npm run dev
npm run eval:live -- --limit 5
```

Before a release, run the full suite and then gate the ignored local result:

```bash
cd frontend
KODEKS_WORKSPACE_ROOT=../evals/workspace-live npm run dev
npm run eval:live -- --reset-workspace
npm run release:check
```

For protected control APIs, pass `--control-token` or set
`KODEKS_EVAL_CONTROL_TOKEN` / `KODEKS_CONTROL_TOKEN` before running
`eval:live`.

`release:check` fails if `evals/results/live-latest.json` is missing, older than
72 hours, does not cover every manifest case, falls below the configured pass
threshold, emits runtime errors, or changes protected verifier files. The
threshold defaults are intentionally strict and can be relaxed only by explicit
`KODEKS_LIVE_EVAL_*` environment overrides.

## Safety Model

kodeks treats local capability as privileged:

- File access is constrained by workspace policy.
- Internal paths such as `.git`, `.kodeks`, dependency folders, and virtual
  environments are blocked.
- Dangerous shell commands become approval records instead of executing
  immediately.
- Approval decisions are auditable and one-shot.

This is a local development project. Review the policy and storage code before
using it on sensitive repositories.

## Documentation

- [`frontend/DEPLOY.md`](./frontend/DEPLOY.md): Vercel deploy runbook (Turso /
  Blob / Sandbox).
- [`oracle/README.md`](./oracle/README.md): golden behavior fixtures.
- [`docs/architecture.md`](./docs/architecture.md): harness design and product
  boundary (conceptual; predates the TS migration).

## License

[MIT](./LICENSE)
