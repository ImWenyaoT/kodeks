# Harness Boundary Checklist

Use this checklist before refactors, cleanup passes, and feature work. The goal
is to keep Kodeks small while deepening the harness around memory,
multi-session state, subagent exploration, plan mode, approvals, observability,
and protocol integration.

## Stable Runtime Behavior

- Chat streams continue to emit the Kodeks SSE event contract:
  `session_created`, `assistant_status`, `text_delta`, `tool_call`,
  `tool_result`, `approval_required`, `memory_recalled`, `plan_artifact`,
  `subagent_started`, `subagent_completed`, `response_completed`, and `error`.
- Chat route execution goes through the Python runtime with DeepSeek/MoonBridge
  as the default model path.
- MoonBridge remains an internal protocol adapter and keeps exposing a local
  Responses-shaped endpoint while forwarding upstream calls to
  `/chat/completions`.
- DeepSeek thinking/tool-call turns preserve `reasoning_content` on assistant
  tool-call messages and replay it with following tool outputs.
- Tool calls and tool outputs remain paired in transcript replay; successful
  tool results continue the same chat turn, while approval-required and unknown
  tool results pause or halt locally.
- Cross-layer contracts use typed names or small Protocols where practical:
  tool schemas, tool statuses, audit event names, and tool-loop replay records
  should not rely on positional indexes or ad hoc strings.
- Shell commands are parsed into argv without shell interpretation; unmatched
  quotes fail before execution and dangerous shell metacharacters require
  approval.
- Plan mode exposes only read-only tools and persists a plan artifact from the
  assistant answer.
- Harness pattern selection remains a fixed small set, records
  `harness_pattern_selected`, and does not execute arbitrary workflow scripts.
- Memory recall and large tool-output compaction continue to expose memory ids,
  layer counts, and artifact refs without copying full artifacts into prompts.
- Subagent exploration records parent session, task, status, summary, and the
  claim/evidence/risk/confidence/nextAction contract.
- Bridge preflight reports `ready` and `unavailable` states with stable
  user-facing status fields.

## Six-Dimension Review

For each pass, answer these questions:

- 状态管理：does the change clarify session, transcript, memory, plan,
  approval, artifact, or subagent state?
- 流程控制：does it preserve or simplify stream, tool loop, continuation,
  pause, halt, or completion behavior?
- 人工审批：does every risky side effect remain gated, auditable, and one-shot?
- 可观测性：can users or developers see the relevant event, failure, audit row,
  smoke result, or eval trace?
- 多 Agent：does subagent behavior stay bounded to exploration, isolation,
  structured summary contract, and parent-session linkage?
- 协议集成：does the Responses-shaped contract, MoonBridge mapping, tool replay,
  and terminal error handling stay intact?

If the answer is “no” across all six dimensions, the change is probably outside
the product boundary.

## Review Pass Template

For each refactor pass, include:

- Current behavior: the user-visible behavior or public contract being kept.
- Harness dimension: which of the six dimensions is being clarified.
- Structural improvement: files or responsibilities moved, deleted, or renamed.
- Validation: focused pytest files, route checks, eval cases, and full Python
  gates that prove behavior stayed stable.

## Standard Validation

- For Python runtime refactors, run `uv run pytest`, `uv run ruff check`, and
  `uv run mypy`.
- For packaging or static UI changes, run `uv build`; the in-tree build backend
  does not need network access.
- If a pass touches docs or examples for user-facing behavior, verify README
  examples match runtime defaults and tests.
