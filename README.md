# kodeks

**kodeks** is a local-first coding agent workbench. Its scope is intentionally
small: a coding agent with memory, multi-session state, subagent exploration,
plan mode, workspace tools, human approval, and a protocol adapter for
OpenAI-compatible Chat Completions, with DeepSeek as the default upstream.

[中文 README](./README.zh-CN.md) · [Architecture](./docs/architecture.md) · [Product requirements](./docs/PRD.md) · [Concept map](./docs/concepts-map.md)

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
- observability through SSE runtime events, smoke checks, eval traces, and
  audit logs;
- multi-agent shape through read-only subagent exploration and persisted
  summaries;
- protocol integration through a Responses-shaped runtime contract and
  MoonBridge conversion to OpenAI-compatible Chat Completions.

The design center is harness understanding: context assembly, tools,
permissions, state, protocol shape, and evaluation.

## Highlights

- FastAPI-served browser UI.
- Streaming chat over Server-Sent Events.
- DeepSeek routing through MoonBridge's OpenAI-compatible Chat Completions adapter.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, plan
  artifacts, and audit logs.
- Plan mode with read-only tool filtering.
- Local deterministic evals for tools, approvals, memory, planning, model
  routing, and UI transport.

## Quick Start

```bash
uv sync
uv run kodeks-server --reload
```

Open `http://127.0.0.1:8000`.

Health check:

```bash
curl http://127.0.0.1:8000/health
```

SSE chat stream:

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required:

- An OpenAI-compatible Chat Completions API key, routed through MoonBridge.
  DeepSeek is the default upstream.

For local development, the simplest path is a project `.env` file:

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

Structured model configuration can also live in either a project-local config
or a user-level config:

- Project-local: `.kodeks/config.json`
- User-level fallback: `~/.kodeks/config.json`
- Override the directory with `KODEKS_CONFIG_DIR`
- Override the exact file with `KODEKS_CONFIG_PATH`

```json
{
  "model": {
    "chatCompletions": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-pro"
    }
  }
}
```

Configuration precedence is:

1. Explicit process environment variables
2. Project `.env`
3. Structured config files

Project-local config is read before the user-level fallback unless
`KODEKS_CONFIG_DIR` or `KODEKS_CONFIG_PATH` is set.

Common options:

- `API_KEY` or `DEEPSEEK_API_KEY`
- `BASE_URL` or `DEEPSEEK_BASE_URL`, defaulting to `https://api.deepseek.com`
- `MODEL` or `DEEPSEEK_MODEL`, defaulting to `deepseek-v4-pro`; the built-in
  DeepSeek catalog includes `deepseek-v4-pro` and `deepseek-v4-flash`
- `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `KODEKS_CHAT_COMPLETIONS_BASE_URL`
- `KODEKS_CHAT_COMPLETIONS_MODEL`
- `KODEKS_BRIDGE_ENABLED=true`
- `KODEKS_BRIDGE_BASE_URL`, defaulting to `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL`, defaulting to `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT`, one of `none`, `low`, `medium`, `high`, or
  `xhigh`
- `KODEKS_STRICT_TOOL_SCHEMAS=true`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

DeepSeek thinking mode is enabled through MoonBridge unless
`KODEKS_BRIDGE_REASONING_EFFORT=none` is set. When the model calls tools,
MoonBridge preserves DeepSeek `reasoning_content` on assistant tool-call
messages so subsequent Chat Completions requests keep the required context
shape.

Runtime state is written under `.kodeks/` by default and is intentionally
ignored by Git. Local `.env` files are also ignored by Git. Project-local model
config can live in `.kodeks/config.json` when structured config is useful.

## MoonBridge

MoonBridge is an internal protocol adapter. Kodeks keeps a Responses-shaped
runtime contract while routing an OpenAI-compatible Chat Completions upstream.
The default upstream is DeepSeek.

Start the runtime with:

```bash
DEEPSEEK_API_KEY=sk-... \
DEEPSEEK_BASE_URL=https://api.deepseek.com \
DEEPSEEK_MODEL=deepseek-v4-pro \
uv run kodeks-server --reload
```

Bridge routes are served by the same FastAPI process:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonbridge","input":"hello","stream":false}'
```

## Development

```bash
uv run pytest
uv run ruff check
uv run mypy
uv build
```

Runtime smoke checks:

```bash
uv run python -m kodeks.smoke --in-process
uv run kodeks-server --reload
uv run python -m kodeks.smoke --base-url http://127.0.0.1:8000
uv run python -m kodeks.smoke --live-provider --model moonbridge
```

The default smoke set covers health, the model catalog, no-side-effect
`/api/chat/stream` validation, and bridge preflight. The live-provider lane
requires configured provider secrets.

Agent evals:

```bash
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py --live-provider
```

The eval suite exercises the FastAPI routes users hit with deterministic model
fakes, then grades event traces by harness dimensions: state management, flow
control, human approval, observability, multi-agent behavior, and protocol
integration. Results are written to `evals/results/latest.json`, which is
ignored by Git.

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

- [`docs/architecture.md`](./docs/architecture.md): current runtime architecture
  and product boundary.
- [`docs/PRD.md`](./docs/PRD.md): product goals, harness criteria, and acceptance
  checks.
- [`docs/concepts-map.md`](./docs/concepts-map.md): harness dimension to code and
  eval coverage map.

Generated notes, scratch docs, local databases, and editor state are
intentionally excluded from version control.

## License

[MIT](./LICENSE)
