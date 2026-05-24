# kodeks

`kodeks` 是一个教学型 coding-agent 项目：目标是为了实习面试，写出一个能讲清楚架构、边界和取舍的 mini opencode/codex。

项目已从 Python/FastAPI 主链路迁移到 TypeScript full-stack 架构。长期目标不是普通 chatbot，而是至少具备 memory、multi-session、plan mode、subagent 能力的 coding agent。

## Reference Sources

参考源按职责分层，不能混用：

- DeepSeek API docs: 对照 chat-completions streaming、function calling 和 stateless multi-round messages。
- `/Users/edward/Documents/src`: agent 产品设计主参考，对照 memory、multi-session、context window、plan mode、tool orchestration、subagent。
- `/Users/edward/Documents/opencode`: coding-agent 结构副参考，对照 session、agent、tool、provider abstraction、plan tool 和权限边界。
- `/Users/edward/Documents/apps.apple.com.-main`: 前端设计参考，对照 App Store 风格的 app shell、shelf 节奏、响应式布局和 accessibility polish。

迁移时把参考项目的模式翻译成更小的 TypeScript 设计，不照搬完整平台架构或受保护前端源码。

## TypeScript Migration

当前 TS scaffold：

- `apps/web`: Next.js App Router UI
- `packages/shared`: shared result and boundary helpers
- `packages/agent-runtime`: future OpenAI Agents SDK runtime
- `packages/model`: future OpenAI JS SDK / Chat Completions model adapter
- `packages/tools`: future model-callable tool registry
- `packages/workspace`: future workspace and shell services
- `packages/storage`: future SQLite repositories

设计文档：`docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md`

## Current Capabilities

TypeScript MVP 已完成：

- Next.js App Router UI and API routes
- OpenAI-compatible Chat Completions model adapter
- OpenAI Agents SDK agent/tool wrapper construction
- Vercel AI SDK UIMessage stream adapter for SDK-native clients
- workspace file boundary with blocked internal paths
- shell harness with timeout and dangerous command detection
- persistent sessions, transcript, memory, approvals, subagent runs, and audit log in SQLite
- `read_file` / `write_file` / `grep` / `run_shell` / `remember_fact` / `recall_memory` / `spawn_explore_agent` tools
- plan mode read-only tool filtering
- SSE chat stream from the TypeScript runtime
- Vercel AI SDK chat stream from the same runtime
- session and approval API routes

The original Python/FastAPI implementation is archived under `legacy/python/` for reference.

## Run

TypeScript workspace:

```bash
pnpm install
pnpm dev
```

Health check:

```bash
curl http://127.0.0.1:3000/api/sessions
```

Chat stream smoke test:

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

Vercel AI SDK UIMessage stream smoke test:

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/ui-stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

Frontend chat demo:

```bash
pnpm --filter @kodeks/web dev
```

Then open `http://127.0.0.1:3000`. The Next.js UI streams chat requests through the
TypeScript runtime.
For a cleaner production-style preview after `npm run build`, use
`npm run start`.

Provider configuration:

- `OPENAI_API_KEY`
- optional `OPENAI_BASE_URL`
- optional `OPENAI_MODEL`, default `gpt-4.1-mini`
- optional `KODEKS_WORKSPACE_ROOT`
- optional `KODEKS_DB_PATH`

## Test

TypeScript:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Architecture

TypeScript target:

- `apps/web`: inbound HTTP/SSE routes and React UI only.
- `packages/agent-runtime`: agent roles, context assembly, stream mapping, and turn orchestration.
- `packages/model`: OpenAI-compatible model clients and adapters.
- `packages/tools`: model-callable tool definitions and policy wrappers.
- `packages/workspace`: workspace path policy, file access, and shell execution.
- `packages/storage`: async SQLite repositories.
- `packages/shared`: cross-package IDs, errors, Result helpers, and JSON utilities.

Python legacy archive:

- `legacy/python/`: original Python/FastAPI implementation kept for behavior comparison.

## Interview Narrative

一句话讲法：

> I migrated a Python/FastAPI mini coding-agent into a TypeScript full-stack coding agent. The MVP uses Next.js, OpenAI Agents SDK wrappers, an OpenAI-compatible Chat Completions adapter, SQLite repositories, workspace/shell services, memory, multi-session resume, plan-mode read-only tools, subagent run records, and auditable one-shot approvals.
