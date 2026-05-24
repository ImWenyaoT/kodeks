# kodeks

`kodeks` 是一个教学型 coding-agent 项目：目标是为了实习面试，写出一个能讲清楚架构、边界和取舍的 mini opencode/codex。

项目正在从 Python/FastAPI 迁移到 TypeScript full-stack 架构。长期目标不是普通 chatbot，而是至少具备 memory、multi-session、plan mode、subagent 能力的 coding agent。

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

已完成：

- workspace file boundary with blocked internal paths
- shell harness with timeout and dangerous command detection
- streaming DeepSeek chat-completions baseline
- persistent conversation state with SQLite
- `read_file` / `write_file` / `run_shell` tool loop through runtime orchestration
- pending approval audit records for dangerous shell commands
- approval API for approving or rejecting pending shell commands once

下一阶段：

`Phase 7: long-term memory`

## Run

TypeScript workspace:

```bash
pnpm install
pnpm dev
```

Python legacy backend:

```bash
uv sync
uv run fastapi dev src/kodeks/main.py
```

Health check:

```bash
curl http://127.0.0.1:8000/health
```

Chat stream smoke test:

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo"}'
```

Frontend chat demo:

```bash
pnpm --filter @kodeks/web dev
```

Then open `http://127.0.0.1:3000`. The Next.js UI proxies chat requests to the
FastAPI backend at `http://127.0.0.1:8000` by default. Override it with
`KODEKS_API_BASE_URL` if the backend runs elsewhere.
For a cleaner production-style preview after `npm run build`, use
`npm run start`.

Provider configuration:

- `LLM_API_KEY` or `DEEPSEEK_API_KEY`
- optional `LLM_BASE_URL` or `DEEPSEEK_BASE_URL`
- optional `LLM_MODEL`, default `deepseek-v4-flash`

## Test

TypeScript:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Python legacy:

```bash
uv run python -m compileall -q src tests
uv run python -m unittest discover -s tests -v
```

If the local environment cannot write to the default uv cache, use a temp cache:

```bash
UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m compileall -q src tests
UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m unittest discover -s tests -v
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

Python legacy:

- `src/kodeks/api/routes/`: inbound FastAPI routes. Routes translate HTTP/SSE only.
- `src/kodeks/runtime/`: agent runtime contracts, event protocol, session state, and provider interface.
- `src/kodeks/services/api/`: outbound API adapters, currently DeepSeek chat completions.
- `src/kodeks/services/`: local workspace, shell, and audit capabilities.
- `src/kodeks/tools/`: model-callable tool registry and local execution wrappers.
- `src/kodeks/schemas/`: HTTP request/response schemas.

Important runtime contracts:

- `ChatStreamEvent`: internal event contract for `text_delta`, `response_completed`, `error`, `tool_call`, and `tool_result`.
- `ChatProviderRequest`: provider-neutral request carrying user input, chat messages, tool definitions, and tool outputs.
- `SessionStateStore`: storage abstraction for session transcript plus a compatibility latest completion id.
- `ToolRegistry`: maps model tool calls to workspace/shell services while preserving safety boundaries.

## Interview Narrative

一句话讲法：

> I built a Python/FastAPI mini coding-agent inspired by opencode/codex. It streams DeepSeek chat-completions events, preserves multi-turn session state through explicit messages, lets the model call workspace and shell tools through a registry, and gates dangerous shell actions behind a one-shot auditable approval flow.

Phase 7 要把当前短期 session context 升级出长期 memory：只保存可解释、可审计、可更新的用户偏好、项目事实和 lessons，避免模型把临时信息静默写进永久状态。
