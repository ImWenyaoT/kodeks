# Refactor Parity Checklist

This checklist freezes behavior that modernization passes must preserve unless a
separate migration task explicitly changes it.

## Stable Runtime Behavior

- Chat streams continue to emit the existing Kodeks SSE event contract:
  `session_created`, `assistant_status`, `text_delta`, `tool_call`,
  `tool_result`, `approval_required`, `memory_recalled`, `plan_artifact`,
  `subagent_started`, `subagent_completed`, `response_completed`, and `error`.
- Model routing keeps the public providers stable: `moonbridge` for
  Chat-Completions-compatible upstreams and `openai`/`responses` for direct
  Responses-compatible endpoints.
- MoonBridge keeps exposing a local Responses-shaped endpoint while forwarding
  upstream calls to `/chat/completions`.
- DeepSeek thinking/tool-call turns preserve `reasoning_content` on assistant
  tool-call messages and replay it with following tool outputs.
- Tool calls and tool outputs remain paired in transcript replay; successful
  tool results continue the same chat turn, while approval-required and unknown
  tool results pause or halt locally instead of sending orphan tool messages.
- Shell commands are parsed into argv without shell interpretation; unmatched
  quotes fail before execution and dangerous shell metacharacters still require
  approval.
- Plan mode exposes only read-only tools and persists a plan artifact from the
  assistant answer.
- Memory recall and large tool-output compaction continue to expose memory ids,
  layer counts, and artifact refs without copying full artifacts into prompts.
- Bridge preflight still reports not-required, unavailable, ready, and recovered
  states with the existing user-facing status fields.
- Chat route execution goes through the Python OpenAI SDK runtime. The
  TypeScript OpenAI/Agents SDK runtime, Next.js shell, and pnpm workspace have
  been removed from active Web chat routes.

## Review Pass Template

For each refactor pass, include:

- Current behavior: the user-visible behavior or public contract being kept.
- Structural improvement: files or responsibilities moved, deleted, or renamed.
- Validation: focused pytest files, route parity checks, and full Python gates
  that prove behavior stayed stable.

## Standard Validation

- For Python runtime refactors, run `uv run pytest`, `uv run ruff check`, and
  `uv run mypy`.
- For packaging or static UI changes, run `uv build`; the in-tree build backend
  does not need network access.
- If a pass touches docs or examples for user-facing behavior, verify README
  examples match runtime defaults and tests.
