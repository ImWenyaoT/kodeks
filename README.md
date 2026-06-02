# kodeks

**kodeks** is a local-first coding agent workbench for experimenting with the core loops behind modern software engineering agents: streaming chat, workspace tools, shell approvals, memory, sessions, plan mode, and subagent exploration.

[中文 README](./README.zh-CN.md) · [Product requirements](./docs/PRD.md) · [Concept map](./docs/concepts-map.md) · [Modernization plan](./docs/MODERNIZATION.md) · [Historical TS design](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## Status

kodeks has completed the active migration away from the TypeScript OpenAI/Agents SDK workspace and now runs on the Python OpenAI SDK behind FastAPI. The current implementation is an MVP, not a hosted product. It is designed to be small enough to study and extend while still preserving the boundaries a real coding agent needs.

Chat now requires the Python/FastAPI runtime. The old TypeScript OpenAI/Agents SDK runtime, Next.js API routes, pnpm workspace, and TypeScript web shell have been removed from the active repository. Python owns the UI entrypoint, API routes, chat runtime, model routing, storage, workspace tools, approvals, and bridge compatibility layers.

## Highlights

- Python-hosted browser UI served by FastAPI.
- Streaming chat over Server-Sent Events.
- DeepSeek-only chat model routing through MoonBridge.
- Built-in MoonBridge adapter for exposing DeepSeek Chat Completions through a local Responses API.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, and audit logs.
- Plan mode with read-only tool filtering.

## Quick Start

```bash
uv sync
uv run kodeks-server --reload
```

Open `http://127.0.0.1:8000`.

Installed packages expose the same server entrypoint as `kodeks-server`.

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

- A DeepSeek Chat Completions API key, routed through MoonBridge.

Kodeks no longer requires secrets to live in the repo `.env`. For local product-style use, put model configuration in the user config file outside the workspace:

- Default: `~/.kodeks/config.json`
- Override the directory with `KODEKS_CONFIG_DIR`
- Override the exact file with `KODEKS_CONFIG_PATH`

Kodeks still reads the earlier platform-specific config path as a compatibility fallback when the new `~/.kodeks/config.json` file does not exist.

DeepSeek is the only supported chat provider. Configure the standard Chat
Completions keys and Kodeks will route through the local MoonBridge adapter.

```json
{
  "model": {
    "provider": "moonbridge",
    "chatCompletions": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-pro"
    }
  }
}
```

DeepSeek defaults:

- `KODEKS_CHAT_COMPLETIONS_BASE_URL` defaults to `https://api.deepseek.com`
- `KODEKS_CHAT_COMPLETIONS_MODEL` defaults to `deepseek-v4-pro`
- `KODEKS_MODEL_PROVIDER=moonbridge` forces the DeepSeek/MoonBridge path

DeepSeek V4 thinking mode is enabled through MoonBridge unless
`KODEKS_BRIDGE_REASONING_EFFORT=none` is set. When the model calls tools,
MoonBridge preserves DeepSeek's `reasoning_content` on assistant tool-call
messages so subsequent Chat Completions requests keep the context shape the
DeepSeek API requires.

Environment variables still work for development and deployment secrets. Explicit environment variables override the user config file.

Provider registries are accepted for compatibility, but only the `deepseek`
entry is used for chat routing:

```json
{
  "model": {
    "primary": "deepseek/deepseek-v4-pro",
    "providers": {
      "deepseek": {
        "api": "chat-completions",
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-...",
        "models": [{ "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }]
      }
    }
  },
  "embeddings": {
    "enabled": true,
    "provider": "local"
  }
}
```

Memory embedding rerank is optional. When enabled, it defaults to a no-download
local hash embedding provider and caches vectors in SQLite. For stronger
semantic ranking, switch explicitly to Ollama or a Hugging Face-compatible
feature extraction endpoint:

```bash
KODEKS_EMBEDDINGS_ENABLED=true
KODEKS_EMBEDDINGS_PROVIDER=local

# Optional: local Ollama
KODEKS_EMBEDDINGS_PROVIDER=ollama
KODEKS_OLLAMA_BASE_URL=http://127.0.0.1:11434
KODEKS_OLLAMA_EMBED_MODEL=embeddinggemma

# Optional: LM Studio / OpenAI-compatible embeddings endpoint
KODEKS_EMBEDDINGS_PROVIDER=lmstudio
KODEKS_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:1234/v1
KODEKS_OPENAI_COMPAT_EMBED_MODEL=embedding-model

# Optional: Hugging Face-compatible endpoint
KODEKS_EMBEDDINGS_PROVIDER=huggingface
KODEKS_HUGGINGFACE_EMBED_MODEL=ibm-granite/granite-embedding-97m-multilingual-r2
KODEKS_HUGGINGFACE_API_TOKEN=hf_...
```

Optional:

- `KODEKS_MODEL_PROVIDER=moonbridge` selects the DeepSeek/MoonBridge route; direct `openai` / `responses` chat providers have been removed
- `KODEKS_CHAT_COMPLETIONS_API_KEY`, `KODEKS_CHAT_COMPLETIONS_BASE_URL`, and `KODEKS_CHAT_COMPLETIONS_MODEL` configure the upstream Chat Completions endpoint used by MoonBridge
- `KODEKS_BRIDGE_ENABLED=true` enables the built-in bridge Responses path
- `KODEKS_BRIDGE_BASE_URL` is the local MoonBridge Responses URL and defaults to `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL` is the local MoonBridge model alias and defaults to `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `KODEKS_STRICT_TOOL_SCHEMAS=true` opts Responses/Agents function tools into strict schemas after local schema normalization; the default remains `strict: false`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

Removed migration aliases:

- `DEEPSEEK_API_KEY` -> `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `DEEPSEEK_BASE_URL` -> `KODEKS_CHAT_COMPLETIONS_BASE_URL`
- `DEEPSEEK_MODEL` -> `KODEKS_CHAT_COMPLETIONS_MODEL`
- `KODEKS_BRIDGE_DEEPSEEK_*` -> `KODEKS_CHAT_COMPLETIONS_*`
- `MOONBRIDGE_API_KEY`, `MOONBRIDGE_BASE_URL`, `MOONBRIDGE_MODEL`, `MOONBRIDGE_ENABLED`, `MOONBRIDGE_REASONING_EFFORT` -> matching `KODEKS_BRIDGE_*` names
- Provider overrides `bridge`, `deepseek`, and `chat-completions` -> `moonbridge`

Runtime state is written under `.kodeks/` by default and is intentionally ignored by Git.

`/api/chat/stream` remains the stable Kodeks SSE runtime path. `/api/chat/ui` is an experimental adapter route that maps the same runtime events into UI-transport-shaped SSE payloads without changing provider execution.

### MoonBridge for Chat Completions

MoonBridge exists for OpenAI-compatible services that expose Chat Completions but not Responses. The Python runtime exposes Responses-shaped bridge routes and converts those requests to `/chat/completions` upstream.

Start the Python runtime with:

```bash
KODEKS_CHAT_COMPLETIONS_API_KEY=sk-... \
KODEKS_CHAT_COMPLETIONS_BASE_URL=https://api.deepseek.com \
KODEKS_CHAT_COMPLETIONS_MODEL=deepseek-v4-pro \
uv run kodeks-server --reload
```

The bridge endpoint is available from the Python service at `/v1/responses`. Setting the same `KODEKS_CHAT_COMPLETIONS_*` values and selecting `moonbridge` is enough for Kodeks to use it.

Bridge health and smoke checks target the Python service:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonbridge","input":"hello","stream":false}'
```

The old TypeScript `moonbridge:*` and `bridge:*` script aliases have been removed with the TypeScript SDK backend packages.

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

The first command does not open a socket. Installed packages expose the same
smoke entrypoint as `kodeks-smoke`. The default smoke set covers health, the
model catalog, no-side-effect `/api/chat/stream` validation, and bridge
preflight. The final command calls `/v1/responses` and requires configured
provider secrets.

Agent evals:

```bash
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py --live-provider
```

The eval suite exercises the FastAPI routes users hit with deterministic model
and Agents SDK fakes, then grades event traces by OpenAI concept: tools,
approvals, context management, memory, planning, model routing, and UI
transport. The optional `--live-provider` lane adds real provider cases using
the configured model credentials and reports latency in the result JSON. It
writes `evals/results/latest.json`, which is ignored by Git.

The TypeScript OpenAI/Agents SDK backend packages, Next.js shell, and pnpm workspace have been removed. The Python runtime currently covers health, model catalog, sessions, workspace file listing, approvals, MoonBridge protocol adapters, deterministic chat-loop tests, same-turn tool continuations, local tool execution, approval-required events, UI transport mapping, static UI serving, and route-level chat streaming through DeepSeek/MoonBridge.

- `src/kodeks`: Python compatibility runtime, FastAPI routes, Pydantic contracts, SQLite repositories, model config, MoonBridge adapter, tools, workspace policy, and SSE helpers.

## Safety Model

kodeks treats local capability as privileged:

- File access is constrained by workspace policy.
- Internal paths such as `.git`, `.kodeks`, dependency folders, and virtual environments are blocked.
- Dangerous shell commands become approval records instead of executing immediately.
- Approval decisions are auditable and one-shot.

This is a local development project. Review the policy and storage code before using it on sensitive repositories.

## Documentation

- [`docs/PRD.md`](./docs/PRD.md): product goals, capability roadmap, and acceptance criteria.
- [`docs/concepts-map.md`](./docs/concepts-map.md): OpenAI concept to Kodeks asset and eval coverage map.
- [`docs/MODERNIZATION.md`](./docs/MODERNIZATION.md): model-provider migration, dependency status, validation, and rollback plan.
- [`docs/superpowers/`](./docs/superpowers/): design specs that should stay synchronized across machines.

Generated notes, scratch docs, local databases, and editor state are intentionally excluded from version control.

## License

[MIT](./LICENSE)
