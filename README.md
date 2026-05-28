# kodeks

**kodeks** is a local-first TypeScript coding agent runtime for experimenting with the core loops behind modern software engineering agents: streaming chat, workspace tools, shell approvals, memory, sessions, plan mode, and subagent exploration.

[中文 README](./README.zh-CN.md) · [Product requirements](./docs/PRD.md) · [Migration design](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## Status

kodeks has migrated from a Python/FastAPI prototype to a TypeScript workspace. The current implementation is an MVP, not a hosted product. It is designed to be small enough to study and extend while still preserving the boundaries a real coding agent needs.

The legacy Python implementation has been removed from the active repository; the TypeScript workspace is now the only maintained runtime.

## Highlights

- Next.js App Router web app and API routes.
- Streaming chat over Server-Sent Events.
- OpenAI Agents SDK as the primary agent runtime, pinned to the Responses API for OpenAI-compatible providers.
- Built-in TypeScript Responses bridge for running DeepSeek through an OpenAI Responses-compatible local endpoint.
- DeepSeek Chat Completions adapter kept as the non-Responses fallback with Thinking Mode and function tool streaming.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, and audit logs.
- Plan mode with read-only tool filtering.
- Vercel AI SDK UIMessage stream adapter for SDK-native clients.

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

Vercel AI SDK UIMessage stream:

```bash
curl -N -X POST "$APP_URL/api/chat/ui-stream" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required:

- `OPENAI_API_KEY` for the default OpenAI Agents SDK + Responses path, `KODEKS_MODEL_PROVIDER=bridge` with the local bridge, or `DEEPSEEK_API_KEY` for direct DeepSeek Chat Completions fallback.

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

# Optional: Hugging Face-compatible endpoint
KODEKS_EMBEDDINGS_PROVIDER=huggingface
KODEKS_HUGGINGFACE_EMBED_MODEL=ibm-granite/granite-embedding-97m-multilingual-r2
KODEKS_HUGGINGFACE_API_TOKEN=hf_...
```

Optional:

- `KODEKS_MODEL_PROVIDER` can be `bridge`, `moonbridge`, `deepseek`, or `openai`
- `KODEKS_BRIDGE_ENABLED=true` enables the built-in bridge Responses path
- `KODEKS_BRIDGE_BASE_URL` defaults to `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL` defaults to `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `MOONBRIDGE_*` environment names are still accepted as compatibility aliases
- `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`
- `DEEPSEEK_MODEL` defaults to `deepseek-v4-pro`
- `DEEPSEEK_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL` defaults to `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT` defaults to `medium`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

Runtime state is written under `.kodeks/` by default and is intentionally ignored by Git.

### Built-in Bridge + DeepSeek Responses

Start the built-in TypeScript bridge so it exposes `http://127.0.0.1:38440/v1/responses`, then run Kodeks with:

```bash
KODEKS_BRIDGE_DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY pnpm run bridge:start
KODEKS_MODEL_PROVIDER=bridge pnpm run dev
```

In this mode Kodeks sends Responses API-shaped requests to its local bridge, and the bridge routes them to DeepSeek V4 through Chat Completions.

Bridge helpers:

```bash
pnpm run bridge:start
pnpm run bridge:health
pnpm run bridge:smoke
```

The old `moonbridge:start`, `moonbridge:health`, and `moonbridge:smoke` scripts remain compatibility aliases for the built-in bridge.

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
- `packages/model`: fallback provider adapters for DeepSeek Chat Completions and direct Responses-compatible model calls.
- `packages/responses-bridge`: built-in Responses-to-DeepSeek bridge with protocol adapters.
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
- [`docs/superpowers/`](./docs/superpowers/): design specs that should stay synchronized across machines.
- [`AGENTS.md`](./AGENTS.md): local agent collaboration instructions.

Generated notes, scratch docs, local databases, and editor state are intentionally excluded from version control.

## License

[MIT](./LICENSE)
