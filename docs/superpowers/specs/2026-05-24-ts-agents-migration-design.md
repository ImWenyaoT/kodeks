# TS Agents Migration Design

## Status

Approved direction from planning conversation. This document freezes the migration design before implementation.

## Goal

Migrate `kodeks` from a Python/FastAPI teaching implementation to a TypeScript full-stack coding agent while keeping the PRD product goal unchanged: a mini opencode/codex-style coding agent with memory, multi-session resume, plan mode, subagents, workspace tools, shell execution, and auditable approvals.

The migrated project should be strong enough to publish as an open-source resume project. The engineering story should be that `kodeks` uses a modern TypeScript stack while preserving clean runtime boundaries, testable local services, and explicit safety controls.

## Non-Goals

- Do not change the core product scope in `docs/PRD.md`.
- Do not keep Python and TypeScript as long-term peer backends.
- Do not introduce Responses API, Ark, MCP, cloud sandbox, plugin marketplace, multi-user auth, or WebSocket transport in the MVP.
- Do not use Vercel AI SDK as the agent tool-loop owner.
- Do not introduce Drizzle in the MVP. Use SQLite behind async repository modules.
- Do not make subagents mutate workspace state in the MVP.

## Reference Priority

1. `/Users/edward/Documents/src`: primary product and behavior reference for memory, planning, tool orchestration, subagent isolation, context assembly, and permission UX.
2. `/Users/edward/Documents/opencode`: secondary structure reference for agent roles, session shape, tool contracts, permission rules, and coding-agent package boundaries.
3. `/Users/edward/Documents/apps.apple.com.-main`: frontend design reference for polished App Store-style app shell, responsive shelves, card rhythm, system color tokens, and accessibility details. Use it for visual and interaction principles only; do not copy Apple-owned code, assets, content, or Svelte-specific implementation patterns.
4. Existing `kodeks` Python code: behavior source of truth for workspace boundary, shell policy, approval audit, session state, memory JSONL, plan mode, and current tests.

The migration should translate patterns into a smaller TypeScript design. It should not clone either reference repository's full platform architecture.

## Chosen Stack

- TypeScript
- pnpm workspace
- Next.js App Router
- OpenAI Agents SDK for agent loop, tool execution, streaming, tracing, and subagent patterns
- OpenAI JS SDK for Chat Completions client and future provider-compatible base URLs
- Vercel AI SDK for React chat state and UI stream helpers only
- SQLite for local durable state
- zod for runtime schemas
- vitest for unit and integration tests
- Playwright for browser verification

## Runtime Boundary

The stable boundary remains:

```text
route -> runtime -> model/agent -> tool registry -> services -> storage
```

In the TypeScript migration:

```text
Next.js route
  -> runChatTurn()
  -> OpenAI Agents SDK Runner
  -> Agent tools
  -> workspace/shell/memory/session services
  -> SQLite repositories
```

Routes translate HTTP and streams only. They must not perform workspace reads, shell execution, memory decisions, approval policy, or agent tool orchestration directly.

## Package Layout

```text
apps/web
  app/api/chat/route.ts
  app/api/sessions/route.ts
  app/api/approvals/[id]/route.ts
  app/page.tsx
  components/chat/
  components/sessions/
  components/approvals/

packages/agent-runtime
  agents/build-agent.ts
  agents/plan-agent.ts
  agents/explore-agent.ts
  runner/run-chat-turn.ts
  context/build-agent-context.ts
  events/agent-event.ts
  events/map-agent-stream.ts
  prompts/

packages/model
  openai-client.ts
  chat-completions-model.ts

packages/tools
  registry.ts
  read-file.ts
  write-file.ts
  grep.ts
  run-shell.ts
  remember-fact.ts
  spawn-explore-agent.ts
  permissions.ts

packages/workspace
  path-policy.ts
  workspace-service.ts
  shell-service.ts

packages/storage
  db.ts
  schema.sql
  sessions.ts
  memories.ts
  approvals.ts
  subagents.ts
  audit-log.ts

packages/shared
  ids.ts
  result.ts
  errors.ts
  json.ts
```

## Agent Roles

### Build Agent

The default coding agent. It can read files, search, write files within the workspace, request shell execution, remember facts, and ask for an explore subagent.

The Build Agent uses OpenAI Agents SDK with Chat Completions model support. It receives session transcript, recalled memory, workspace summary, current mode, and tool policy context.

### Plan Agent

The read-only planning agent. It can inspect files and ask clarifying questions, but it cannot write files or run mutating shell commands.

Plan mode outputs a plan artifact that can be approved by the user before execution. The MVP stores the plan in SQLite as the canonical record and writes a markdown copy under `.kodeks/plans/` for human inspection.

### Explore Agent

The read-only subagent. It is optimized for codebase exploration and returns a structured summary to the Build Agent. It can use `read_file`, `grep`, and `list_files`. It cannot write files, run shell commands, or spawn further subagents in the MVP.

## Transport Design

Use SSE/HTTP streaming for MVP.

Reasons:

- The primary flow is server-to-client streaming.
- Approval, session actions, and follow-up prompts fit ordinary HTTP POST endpoints.
- SSE is simple to test with `curl -N`.
- Next.js route handlers and Vercel AI SDK UI stream helpers fit HTTP streaming.

Do not use WebSocket until a feature requires true bidirectional long-lived interaction, such as an interactive terminal, collaborative sessions, or voice/realtime UX.

## Agent Event Contract

The app owns a stable internal event contract. OpenAI Agents SDK stream events must be mapped into this event contract before reaching the UI.

```ts
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; status: "ok" | "error" | "approval_required" }
  | { type: "approval_required"; approvalId: string; toolCallId: string; reason: string }
  | { type: "memory_recalled"; memoryIds: string[] }
  | { type: "subagent_started"; runId: string; agent: "explore" }
  | { type: "subagent_completed"; runId: string; summary: string }
  | { type: "response_completed"; sessionId: string }
  | { type: "error"; message: string; code?: string };
```

The UI may convert these events into Vercel AI SDK UI messages, but `AgentEvent` remains the product-level event contract.

## Storage Design

Use SQLite directly through async repository modules. Do not use callback-style database access.

Core tables:

- `sessions`: id, title, mode, workspace_root, parent_session_id, created_at, updated_at, archived_at
- `messages`: id, session_id, role, content_json, agent_event_json, created_at
- `memories`: id, scope, content, source_session_id, confidence, created_at, updated_at, deleted_at
- `approvals`: id, session_id, tool_call_id, command_json, status, reason, created_at, decided_at
- `subagent_runs`: id, parent_session_id, agent_name, task, summary, status, created_at, completed_at
- `audit_log`: id, session_id, event_type, payload_json, created_at

Repositories must expose promise-returning functions only. Tests should exercise repositories against a temporary SQLite database.

## Tool Policy

Tools are deterministic TypeScript functions wrapped for OpenAI Agents SDK.

MVP tools:

- `read_file`: reads workspace files through `WorkspaceService`.
- `write_file`: whole-file overwrite within workspace boundary.
- `grep`: searches workspace text using fast local search.
- `run_shell`: executes safe commands with timeout and records dangerous commands as approval requests.
- `remember_fact`: writes explicit memory records.
- `spawn_explore_agent`: starts a read-only Explore Agent and returns its summary.

Policy defaults:

- Internal paths such as `.git`, `.kodeks`, `.venv`, `node_modules`, and build output are blocked or restricted.
- `.env` and `.env.*` reads require approval unless the request is clearly for safe metadata.
- Writes are workspace-bound.
- Shell commands are timeout-bound and classified before execution.
- Dangerous shell commands create approval records and do not execute immediately.

## Memory Design

Memory is explicit, scoped, and auditable.

Scopes:

- `user`: durable user preferences.
- `project`: durable project facts and decisions.
- `session`: local session notes and intermediate context.

Recall happens before each agent run through `buildAgentContext()`. The MVP can use keyword scoring and recency without a vector database. Memory writes happen through `remember_fact` or a controlled extraction step, not silent arbitrary model writes.

## Multi-Session Design

Sessions persist transcript and metadata. A resumed session rebuilds context from stored messages, recalled memory, and workspace state.

The TS migration should preserve existing behavior while making session state explicit enough for:

- session list
- session resume
- parent/child relationship for subagents
- plan mode status
- future compaction

## Plan Mode Design

Plan mode is represented as a separate agent role and session mode, not only a prompt string.

Entering plan mode:

- switches session mode to `plan`
- uses Plan Agent instructions
- restricts tool registry to read-only tools
- emits plan-related events to the UI

Exiting plan mode:

- produces an approval-ready plan artifact
- requires user approval before mutating execution

## Subagent Design

Subagent work is a separate `subagent_runs` record linked to the parent session.

The MVP supports one subagent type:

- `explore`: read-only codebase exploration

The parent agent receives the subagent summary as a tool result. The MVP stores the subagent task, status, and compact summary in `subagent_runs`; full nested subagent transcripts are deferred.

## UI Design

The first screen remains the usable coding-agent chat interface, not a landing page.

Frontend design should additionally reference `/Users/edward/Documents/apps.apple.com.-main` for product polish:

- Use an app-shell composition with a persistent desktop sidebar and a compact mobile top chrome.
- Treat sessions, tool calls, approvals, memory recall, and subagent summaries as structured shelves or timeline rows with consistent rhythm.
- Prefer system-like color tokens, light/dark support, high-contrast compatibility, and clear focus-visible states.
- Use responsive grid and shelf spacing rules so dense coding-agent information stays scannable without becoming a generic dashboard.
- Keep controls precise and familiar: icon buttons for compact actions, segmented controls for modes, and quiet hover/active states.
- Preserve accessibility details such as keyboard focus, reduced visual noise, and readable contrast.

This reference should shape the UI direction, but implementation remains Next.js + React + TypeScript. The MVP should not include Apple content, copied CSS, copied Svelte components, or reverse-engineered private behavior.

MVP UI:

- chat timeline
- tool call rows
- tool result rows
- approval prompt panel
- session list/resume
- plan mode indicator
- subagent summary row
- memory recall indicator
- responsive session/sidebar shell
- frontend tokens for color, spacing, radius, focus, and density

Use Vercel AI SDK for React chat state and stream handling where it fits, but do not delegate runtime tool execution to `streamText` or Vercel AI SDK agents.

## Migration Phases

### Phase 1: Spec and Scaffold

- Add pnpm workspace.
- Create `apps/web` and `packages/*`.
- Add TypeScript, vitest, ESLint, and shared tsconfig.
- Keep Python code in place during scaffold.

### Phase 2: Storage and Services

- Implement SQLite repositories.
- Implement workspace path policy, workspace service, shell service, and audit log.
- Port existing Python tests for workspace, shell, audit, approval, session, and memory behavior.

### Phase 3: Tools and Agent Runtime

- Implement OpenAI Agents SDK tool wrappers.
- Implement Build Agent, Plan Agent, and Explore Agent.
- Implement Chat Completions model configuration with OpenAI JS SDK.
- Implement `runChatTurn()` and `AgentEvent` mapping.

### Phase 4: API and UI

- Implement Next.js `/api/chat` SSE endpoint.
- Implement sessions and approvals API routes.
- Wire chat UI, tool timeline, approval UI, and session resume.
- Verify with Playwright.

### Phase 5: Parity and Cleanup

- Port remaining Python behavior tests.
- Update README and PRD implementation notes.
- Archive or remove Python backend once TS path passes parity.
- Keep a migration note explaining behavior equivalence and changed stack.

## Test Matrix

Storage:

- sessions create/list/resume
- memory insert/recall/delete marker
- approval create/approve/reject/idempotency
- subagent run lifecycle

Workspace:

- allowed read/write
- blocked internal paths
- path traversal denied
- file list/search behavior

Shell:

- safe command execution
- timeout
- dangerous command approval
- approval execution only once

Runtime:

- text-only chat turn
- tool call turn
- write-file tool turn
- shell approval turn
- plan mode filters mutating tools
- explore subagent returns summary
- memory recall is injected

API/UI:

- `/api/chat` streams text and tool events
- approval POST updates state
- session resume loads transcript
- UI renders tool calls, approval prompt, plan indicator, and subagent summary

## Acceptance Criteria

- `pnpm test` passes all TS unit and integration tests.
- `pnpm lint` passes.
- Next.js app runs locally and streams an agent response.
- The migrated stack supports memory, multi-session, plan mode, and one read-only subagent.
- Dangerous shell commands require approval and are auditable.
- The UI follows the App Store reference at the level of layout discipline, shelf rhythm, responsive behavior, and accessibility polish without copying protected code or assets.
- Python backend is no longer required for the main app after parity.
- README has updated run/test instructions and interview narrative.

## Deferred Decisions

- Python files stay in place during migration. After TS parity, move them to a clearly marked legacy archive or remove them in a dedicated cleanup change.
- The first TS MVP uses OpenAI Agents SDK with OpenAI JS SDK and Chat Completions model support. DeepSeek-compatible Chat Completions can be added as a later provider-compatible adapter after the OpenAI path is stable.
- Plan artifacts are stored in SQLite and mirrored to `.kodeks/plans/` in the MVP.
