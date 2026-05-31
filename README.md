# kodeks

**kodeks** is a local-first TypeScript coding agent runtime for experimenting with the core loops behind modern software engineering agents: streaming chat, workspace tools, shell approvals, memory, sessions, plan mode, and subagent exploration.

[中文 README](./README.zh-CN.md) · [Product requirements](./docs/PRD.md) · [Modernization plan](./docs/MODERNIZATION.md) · [Migration design](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## Status

kodeks has migrated from a Python/FastAPI prototype to a TypeScript workspace. The current implementation is an MVP, not a hosted product. It is designed to be small enough to study and extend while still preserving the boundaries a real coding agent needs.

The legacy Python implementation has been removed from the active repository; the TypeScript workspace is now the only maintained runtime.

## Highlights

- Next.js App Router web app and API routes.
- Streaming chat over Server-Sent Events.
- OpenAI Agents SDK as the primary agent runtime, with DeepSeek-first model routing through MoonBridge and OpenAI Responses as fallback.
- Direct Responses-compatible endpoint support.
- Built-in MoonBridge adapter for exposing Chat Completions-compatible endpoints through a local Responses API.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, and audit logs.
- Plan mode with read-only tool filtering.

## Quick Start

```bash
pnpm install
pnpm run dev
```

Open `http://127.0.0.1:3000`.

Next.js defaults to port 3000 when it is free. For repeatable local development,
prefer an explicit port so another app on 3000 cannot change the URL you use:

```bash
PORT=3001 pnpm run dev
APP_URL=http://127.0.0.1:3001
```

On Windows PowerShell:

```powershell
$env:PORT=3001; pnpm run dev
$env:APP_URL="http://127.0.0.1:3001"
```

If you omit `PORT`, use the actual URL printed by Next.js. Do not assume
`localhost:3000` belongs to kodeks when other local web apps are running.

Health check:

```bash
curl "$APP_URL/api/sessions"
```

SSE chat stream:

```bash
curl -N -X POST "$APP_URL/api/chat/stream" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required:

- A Responses-compatible endpoint, or a Chat Completions-compatible endpoint routed through MoonBridge.

Kodeks no longer requires secrets to live in the repo `.env`. For local product-style use, put model configuration in the user config file outside the workspace:

- Default: `~/.kodeks/config.json`
- Override the directory with `KODEKS_CONFIG_DIR`
- Override the exact file with `KODEKS_CONFIG_PATH`

Kodeks still reads the earlier platform-specific config path as a compatibility fallback when the new `~/.kodeks/config.json` file does not exist.

DeepSeek-first is the default routing strategy. Configure the standard Chat Completions keys and Kodeks will prefer the local MoonBridge path; if that path is not configured, it falls back to direct Responses/OpenAI configuration.

```json
{
  "model": {
    "provider": "moonbridge",
    "chatCompletions": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    }
  }
}
```

For an OpenAI-compatible service that already implements the Responses API, choose `provider: "responses"` in `config.json` and Kodeks will call it directly through the OpenAI provider path. For a service that only implements Chat Completions, such as DeepSeek or Qwen deployments, choose MoonBridge and configure the upstream Chat Completions endpoint:

```json
{
  "model": {
    "provider": "moonbridge",
    "chatCompletions": {
      "apiKey": "sk-or-local-placeholder",
      "baseURL": "https://chat-compatible.example/v1",
      "model": "qwen-coder"
    }
  }
}
```

DeepSeek defaults:

- `KODEKS_CHAT_COMPLETIONS_BASE_URL` defaults to `https://api.deepseek.com`
- `KODEKS_CHAT_COMPLETIONS_MODEL` defaults to `deepseek-v4-flash`
- `KODEKS_MODEL_PROVIDER=moonbridge` forces the DeepSeek/MoonBridge path
- `KODEKS_MODEL_PROVIDER=openai` forces the Responses/OpenAI path

Environment variables still work for development and deployment secrets. Explicit environment variables override the user config file.

OpenClaw-style provider registries are also supported. Use `api: "responses"` for direct Responses-compatible endpoints and `api: "chat-completions"` for endpoints that should go through MoonBridge:

```json
{
  "model": {
    "primary": "qwen/qwen3.6",
    "providers": {
      "qwen": {
        "api": "chat-completions",
        "baseURL": "http://172.18.45.70:8010/v1",
        "apiKey": "local-placeholder",
        "models": [{ "id": "qwen3.6", "name": "Qwen 3.6" }]
      }
    }
  },
  "embeddings": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseURL": "http://172.18.45.70:8011/v1",
    "apiKey": "local-placeholder",
    "model": "qwen3-embedding-4b"
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
KODEKS_LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
KODEKS_LMSTUDIO_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B

# Optional: Hugging Face-compatible endpoint
KODEKS_EMBEDDINGS_PROVIDER=huggingface
KODEKS_HUGGINGFACE_EMBED_MODEL=ibm-granite/granite-embedding-97m-multilingual-r2
KODEKS_HUGGINGFACE_API_TOKEN=hf_...
```

Optional:

- `KODEKS_MODEL_PROVIDER` can be `openai`, `responses`, or `moonbridge`; removed aliases now fail with migration guidance
- `KODEKS_RESPONSES_API_KEY`, `KODEKS_RESPONSES_BASE_URL`, and `KODEKS_RESPONSES_MODEL` configure a direct Responses-compatible endpoint; `OPENAI_*` names remain official OpenAI aliases
- `KODEKS_CHAT_COMPLETIONS_API_KEY`, `KODEKS_CHAT_COMPLETIONS_BASE_URL`, and `KODEKS_CHAT_COMPLETIONS_MODEL` configure the upstream Chat Completions endpoint used by MoonBridge
- `KODEKS_BRIDGE_ENABLED=true` enables the built-in bridge Responses path
- `KODEKS_BRIDGE_BASE_URL` is the local MoonBridge Responses URL and defaults to `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL` is the local MoonBridge model alias and defaults to `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL` defaults to `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT` defaults to `medium`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
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

### MoonBridge for Chat Completions

MoonBridge exists for OpenAI-compatible services that expose Chat Completions but not Responses. Kodeks continues to send Responses-shaped requests to `http://127.0.0.1:38440/v1/responses`; MoonBridge converts those requests to `/chat/completions` upstream.

Start the built-in TypeScript bridge, then run Kodeks with:

```bash
KODEKS_CHAT_COMPLETIONS_API_KEY=sk-... \
KODEKS_CHAT_COMPLETIONS_BASE_URL=https://api.deepseek.com \
KODEKS_CHAT_COMPLETIONS_MODEL=deepseek-v4-flash \
pnpm run bridge:start

KODEKS_MODEL_PROVIDER=moonbridge pnpm run dev
```

If Kodeks manages the bridge from the Next.js runtime, setting the same `KODEKS_CHAT_COMPLETIONS_*` values and selecting `moonbridge` is enough; the runtime starts the local bridge when needed.

Bridge helpers:

```bash
pnpm run bridge:start
pnpm run bridge:health
pnpm run bridge:smoke
```

The old `moonbridge:start`, `moonbridge:health`, and `moonbridge:smoke` script aliases have been removed. Use the `bridge:*` scripts above.

## Development

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run start
```

The repository uses pnpm workspaces:

- `apps/web`: UI, API routes, and stream adapters.
- `packages/agent-runtime`: OpenAI Agents SDK turn orchestration, context assembly, plan mode, and local tool wrappers.
- `packages/model`: provider configuration and direct Responses-compatible model calls.
- `packages/responses-bridge`: built-in Responses-to-Chat-Completions bridge with protocol adapters.
- `packages/tools`: model-callable tool registry and policy wrappers.
- `packages/workspace`: workspace path policy, file access, and shell execution.
- `packages/storage`: SQLite repositories.
- `packages/shared`: shared IDs, errors, results, and JSON helpers.

## Safety Model

kodeks treats local capability as privileged:

- File access is constrained by workspace policy.
- Internal paths such as `.git`, `.kodeks`, dependency folders, and virtual environments are blocked.
- Dangerous shell commands become approval records instead of executing immediately.
- Approval decisions are auditable and one-shot.

This is a local development project. Review the policy and storage code before using it on sensitive repositories.

## Documentation

- [`docs/PRD.md`](./docs/PRD.md): product goals, capability roadmap, and acceptance criteria.
- [`docs/MODERNIZATION.md`](./docs/MODERNIZATION.md): model-provider migration, dependency status, validation, and rollback plan.
- [`docs/superpowers/`](./docs/superpowers/): design specs that should stay synchronized across machines.
- [`AGENTS.md`](./AGENTS.md): local agent collaboration instructions.

Generated notes, scratch docs, local databases, and editor state are intentionally excluded from version control.

## License

[MIT](./LICENSE)
