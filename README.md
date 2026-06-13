# kodeks

**kodeks** is a local-first coding agent workbench. Its scope is intentionally
small: a coding agent with memory, multi-session state, subagent exploration,
plan mode, workspace tools, human approval, and a protocol adapter for
OpenAI-compatible Chat Completions, with DeepSeek as the default upstream.

> **Runtime: Python/FastAPI backend + Next.js frontend (two processes).** The
> HTTP API, chat runtime, and local tool execution run as a Python/FastAPI
> service (`src/kodeks/**`, port 8000). The browser UI is a separate Next.js/React
> app (`frontend/`, port 3000) that reverse-proxies `/api/*` to the Python backend
> via `frontend/next.config.ts` rewrites — the browser stays same-origin, so no
> CORS is needed. Behavior is pinned by byte-level golden fixtures under
> [`oracle/`](./oracle/README.md).

[中文 README](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Product requirements](./docs/PRD.md) · [Concept map](./docs/concepts-map.md) · [Deploy](./frontend/DEPLOY.md) · [Oracle fixtures](./oracle/README.md)

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

Two processes. A Python/FastAPI backend (`src/kodeks/**`, port 8000) holds the
HTTP API, chat runtime, and local tool execution. A separate Next.js/React app
(`frontend/`, port 3000; React 19 + Tailwind v4 + shadcn/ui + Zustand) serves
the browser UI. The frontend reverse-proxies `/api/*` to the backend through
`frontend/next.config.ts` rewrites, so the browser stays same-origin and no CORS
is needed.

```
src/kodeks/                  Python/FastAPI backend (port 8000)
  app.py                     FastAPI app + route mounting
  server.py                  uvicorn entry (kodeks-server)
  api/                       chat/session/approval/bridge/workspace routes
    sse.py, ui_transport.py  SSE framing + runtime/UI event transport
  runtime.py, responses_runtime.py, responses_tool_loop.py, harness.py
                             agent loop (turn loop, tool continuation, context)
  tools/                     model tools: registry / schemas / helpers
  storage/                   db / session / memory (SQLite)
  providers/bridge.py        MoonBridge: Responses <-> Chat Completions (DeepSeek)
  config.py, model_config.py env / dotenv / model catalog / provider resolution
  workspace.py               path sandbox + dangerous-command policy + argv exec
  plans.py                   plan-mode state
frontend/                    Next.js/React frontend (port 3000)
  app/                       Next.js App Router: page.tsx, layout.tsx
  components/                React UI
  hooks/                     useModels / useSessions / useChatStream /
                             useApprovals / useBridgePreflight
  stores/                    Zustand state
  lib/                       api.ts / sse.ts / events.ts / i18n.ts / format.ts
                             (client only)
  next.config.ts             rewrites() reverse-proxy /api/* -> 127.0.0.1:8000
oracle/                      golden behavior fixtures (see oracle/README.md)
```

How the frontend reaches the backend: the React client (`frontend/lib/api.ts`)
calls relative `/api/*` URLs. `frontend/next.config.ts` `rewrites()` proxies
`/api/*` (plus `/health`, `/v1/*`, `/responses`, `/models`, `/bridge/health`) to
`http://127.0.0.1:8000` (override with env `KODEKS_API_ORIGIN`). The chat stream
is a POST + `fetch` `ReadableStream` SSE. The default model upstream is DeepSeek
via MoonBridge.

## Quick Start

Install both halves — Python backend (repo root) and Next.js frontend
(`frontend/`):

```bash
uv sync                 # Python backend deps (repo root)
cd frontend && npm install && cd ..
```

Provide DeepSeek credentials in the repo-root `.env` (the Python backend reads
`.env` from its cwd / repo root). Copy the template and fill in the key:

```bash
cp .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

(`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` are aliased to
`KODEKS_CHAT_COMPLETIONS_*`. `KODEKS_API_ORIGIN` is optional and only read by the
Next process — the local default works.)

Run both processes with one command, then open `http://localhost:3000`:

```bash
uv run scripts/dev.py   # launches uvicorn :8000 + next dev :3000, prefixes
                        # logs, propagates Ctrl-C
```

Or run them manually in two terminals:

```bash
# terminal 1 — Python backend (repo root)
uv run kodeks-server --reload --port 8000

# terminal 2 — Next.js frontend
cd frontend && npm run dev
```

Open the UI at `http://localhost:3000`. Smoke-check the backend directly on
:8000 (the frontend proxies the same routes on :3000):

```bash
curl http://127.0.0.1:8000/health
curl -N -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required: an OpenAI-compatible Chat Completions API key, routed through
MoonBridge. DeepSeek is the default upstream. Credentials live in the repo-root
`.env`, which the Python backend loads from its cwd / repo root (`config.py`).

Configuration precedence is:

1. Explicit process environment variables
2. Repo-root `.env` (read by the Python backend)
3. Structured config files (`.kodeks/config.json`, then `~/.kodeks/config.json`)

Common options:

- `API_KEY` / `DEEPSEEK_API_KEY` → `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `BASE_URL` / `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`)
- `MODEL` / `DEEPSEEK_MODEL` (default `deepseek-v4-pro`; catalog includes
  `deepseek-v4-pro` and `deepseek-v4-flash`)
- `KODEKS_BRIDGE_REASONING_EFFORT` ∈ `none|low|medium|high|xhigh`
- `KODEKS_WORKSPACE_ROOT`, `KODEKS_DB_PATH`
- `KODEKS_API_ORIGIN` (Next process only; where the frontend proxies `/api/*`;
  default `http://127.0.0.1:8000`). Optional — if set, it can live in
  `frontend/.env.local`.

Persistence: the Python backend keeps a local SQLite file under
`.kodeks/kodeks.sqlite3` by default (override with `KODEKS_DB_PATH`). For
deployment options, see [`frontend/DEPLOY.md`](./frontend/DEPLOY.md).

## MoonBridge

MoonBridge is an internal protocol adapter (`src/kodeks/providers/bridge.py`,
exposed through `src/kodeks/api/bridge_routes.py`). The runtime keeps a
Responses-shaped contract while routing an OpenAI-compatible Chat Completions
upstream (DeepSeek by default). It converts the request
(`instructions`/`input`/`tools`/`reasoning.effort`) and maps the streamed
`chat.completion.chunk` responses back to Responses events, preserving DeepSeek
`reasoning_content` on tool-call turns.

## Development

Backend checks run from the repo root:

```bash
uv sync
uv run ruff check
uv run mypy
uv run pytest
uv run python -m kodeks.smoke --in-process   # offline smoke check
uv build                                      # build the package
```

Frontend checks run from `frontend/`:

```bash
cd frontend
npm install
npm run lint        # eslint
npm test            # vitest
npm run build       # next build
```

CI runs the same gates (`.github/workflows/ci.yml`).

### Behavior parity (oracle)

[`oracle/`](./oracle/README.md) holds golden behavior snapshots (event
sequences, byte-exact SSE, audit rows) across 14 scenarios. The Python test
`tests/test_route_parity.py` replays them and asserts byte-for-byte equivalence,
pinning the backend's behavior to those fixtures.

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

- [`frontend/DEPLOY.md`](./frontend/DEPLOY.md): deployment runbook.
- [`oracle/README.md`](./oracle/README.md): golden behavior fixtures.
- [`docs/architecture.md`](./docs/architecture.md): harness design and product
  boundary (conceptual).

## License

[MIT](./LICENSE)
