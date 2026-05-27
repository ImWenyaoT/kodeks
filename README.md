# kodeks

**kodeks** is a local-first TypeScript coding agent runtime for experimenting with the core loops behind modern software engineering agents: streaming chat, workspace tools, shell approvals, memory, sessions, plan mode, and subagent exploration.

[中文 README](./README.zh-CN.md) · [Product requirements](./docs/PRD.md) · [Migration design](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## Status

kodeks has migrated from a Python/FastAPI prototype to a TypeScript workspace. The current implementation is an MVP, not a hosted product. It is designed to be small enough to study and extend while still preserving the boundaries a real coding agent needs.

The legacy Python implementation has been removed from the active repository; the TypeScript workspace is now the only maintained runtime.

## Highlights

- Next.js App Router web app and API routes.
- Streaming chat over Server-Sent Events.
- Moon Bridge Responses provider for running DeepSeek through an OpenAI Responses-compatible local bridge.
- DeepSeek Chat Completions adapter with Thinking Mode and function tool streaming.
- OpenAI Responses API adapter kept as a fallback provider.
- OpenAI Agents SDK wrapper construction for agents and tools.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, and audit logs.
- Plan mode with read-only tool filtering.
- Vercel AI SDK UIMessage stream adapter for SDK-native clients.

## Quick Start

```bash
bun install
bun run dev
```

Open `http://127.0.0.1:3000`.

Next.js defaults to port 3000 when it is free. For repeatable local development,
prefer an explicit port so another app on 3000 cannot change the URL you use:

```bash
PORT=3001 bun run dev
APP_URL=http://127.0.0.1:3001
```

On Windows PowerShell:

```powershell
$env:PORT=3001; bun run dev
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

- `KODEKS_MODEL_PROVIDER=moonbridge` when Moon Bridge is running, or `DEEPSEEK_API_KEY` for direct DeepSeek Chat Completions, or `OPENAI_API_KEY` for the OpenAI Responses fallback.

Optional:

- `KODEKS_MODEL_PROVIDER` can be `moonbridge`, `deepseek`, or `openai`
- `MOONBRIDGE_ENABLED=true` also enables the Moon Bridge Responses path
- `MOONBRIDGE_BASE_URL` defaults to `http://127.0.0.1:38440/v1`
- `MOONBRIDGE_MODEL` defaults to `moonbridge`
- `MOONBRIDGE_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `DEEPSEEK_BASE_URL` defaults to `https://api.deepseek.com`
- `DEEPSEEK_MODEL` defaults to `deepseek-v4-pro`
- `DEEPSEEK_REASONING_EFFORT` defaults to `high`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL` defaults to `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT` defaults to `medium`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

Runtime state is written under `.kodeks/` by default and is intentionally ignored by Git.

### Moon Bridge + DeepSeek Responses

DeepSeek's official Codex guide recommends using Moon Bridge as a local Responses-compatible bridge. Start Moon Bridge so it exposes `http://127.0.0.1:38440/v1/responses`, then run Kodeks with:

```bash
KODEKS_MODEL_PROVIDER=moonbridge bun run dev
```

In this mode Kodeks sends Responses API-shaped requests to Moon Bridge, and Moon Bridge routes them to DeepSeek V4. See the DeepSeek guide: <https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/codex.md>.

## Development

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run start
```

The repository uses Bun workspaces:

- `apps/web`: UI, API routes, and stream adapters.
- `packages/agent-runtime`: turn orchestration, context assembly, plan mode, and agent/tool wrappers.
- `packages/model`: Moon Bridge Responses, DeepSeek Chat Completions, and OpenAI Responses model clients behind one runtime contract.
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
