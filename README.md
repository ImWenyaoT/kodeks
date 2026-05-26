# kodeks

**kodeks** is a local-first TypeScript coding agent runtime for experimenting with the core loops behind modern software engineering agents: streaming chat, workspace tools, shell approvals, memory, sessions, plan mode, and subagent exploration.

[中文 README](./README.zh-CN.md) · [Product requirements](./docs/PRD.md) · [Migration design](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## Status

kodeks has migrated from a Python/FastAPI prototype to a TypeScript workspace. The current implementation is an MVP, not a hosted product. It is designed to be small enough to study and extend while still preserving the boundaries a real coding agent needs.

The original Python implementation has been removed from the active repository. Historical behavior can be inspected through Git history and the migration design notes.

## Highlights

- Next.js App Router web app and API routes.
- Streaming chat over Server-Sent Events.
- OpenAI Responses API adapter with function tool streaming.
- OpenAI Agents SDK wrapper construction for agents and tools.
- Workspace-scoped file tools with internal path blocking.
- Shell execution harness with timeout and dangerous command detection.
- SQLite-backed sessions, transcripts, memories, approvals, subagent runs, and audit logs.
- Plan mode with read-only tool filtering.
- Vercel AI SDK UIMessage stream adapter for SDK-native clients.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:3000`.

Health check:

```bash
curl http://127.0.0.1:3000/api/sessions
```

SSE chat stream:

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

Vercel AI SDK UIMessage stream:

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/ui-stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## Configuration

Required:

- `OPENAI_API_KEY`

Optional:

- `OPENAI_BASE_URL`
- `OPENAI_MODEL` defaults to `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT` defaults to `medium`; supported values are `none`, `low`, `medium`, `high`, and `xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

Runtime state is written under `.kodeks/` by default and is intentionally ignored by Git.

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The repository uses `pnpm` workspaces:

- `apps/web`: UI, API routes, and stream adapters.
- `packages/agent-runtime`: turn orchestration, context assembly, plan mode, and agent/tool wrappers.
- `packages/model`: OpenAI Responses API model client.
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
