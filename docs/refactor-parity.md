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
- Tool calls and tool outputs remain paired in transcript replay; approval
  required results pause the current turn instead of sending orphan tool
  messages.
- Plan mode exposes only read-only tools and persists a plan artifact from the
  assistant answer.
- Memory recall and large tool-output compaction continue to expose memory ids,
  layer counts, and artifact refs without copying full artifacts into prompts.
- Bridge preflight still reports not-required, unavailable, ready, and recovered
  states with the existing user-facing status fields.

## Review Pass Template

For each refactor pass, include:

- Current behavior: the user-visible behavior or public contract being kept.
- Structural improvement: files or responsibilities moved, deleted, or renamed.
- Validation: package tests and parity checks that prove behavior stayed stable.

## Standard Validation

- For package-local refactors, run the touched package tests first.
- After TypeScript or JavaScript changes, run `npm test`.
- Before a commit-ready handoff, run `pnpm lint`, `pnpm typecheck`, and
  `pnpm run format:check`.
- If a pass touches docs or examples for user-facing behavior, verify README
  examples match runtime defaults and tests.
