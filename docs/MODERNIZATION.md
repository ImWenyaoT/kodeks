# Modernization Plan

Kodeks is already mid-migration: the active runtime is a TypeScript workspace, while older Python/FastAPI and direct Chat Completions assumptions have been removed or isolated. Future modernization should stay incremental, with parity checks before each transition.

## Stack Map

| Legacy surface | Target stack | Parity signal |
| --- | --- | --- |
| Python/FastAPI prototype | Next.js App Router plus TypeScript packages | `pnpm run test`, `pnpm run typecheck`, and `/api/chat/stream` smoke coverage |
| Provider-specific agent loops | OpenAI Agents SDK over a Responses-shaped model boundary | Text delta, tool call, tool output, and completion event tests |
| Direct Chat Completions routing | MoonBridge exposing Chat Completions providers as local Responses endpoints | Bridge unit tests plus `pnpm run bridge:smoke` |
| Repo-local secret assumptions | User config at `~/.kodeks/config.json` with env overrides | Config resolver tests for provider registries and env precedence |
| Multiple stream contracts | One Kodeks SSE event contract | Web runtime and UI stream parser tests |
| Ad hoc storage | SQLite repositories for sessions, messages, approvals, memories, and subagents | Storage package tests and migration smoke checks |

## Milestones

1. Stabilize model routing.
   Keep only `openai` and `moonbridge` as runtime providers. Reject removed aliases with migration guidance. Validate with model resolver tests and bridge request tests.

2. Harden the Responses boundary.
   Treat Responses as the canonical integration shape. Keep direct OpenAI calls stateless with `store: false` while Kodeks owns transcript state locally. Evaluate `previous_response_id`, hosted tools, and structured outputs only behind explicit feature flags.

3. Prove runtime parity.
   Before replacing any runtime path, compare text streaming, tool-call sequencing, tool output replay, plan-mode filtering, approvals, and final completion behavior against existing fixtures.

4. Reduce large-file complexity.
   Extract only stable seams: provider resolution, transcript conversion, bridge stream mapping, and UI event rendering. Each pass should remove duplication or clarify ownership without changing public behavior.

5. Clean stale surfaces.
   Remove dead aliases, duplicate stream adapters, unused script names, and docs for behavior no longer visible in the repo. Every removal needs a test or documented migration path.

6. Revisit stateful API features.
   Once local parity is boring, benchmark `previous_response_id` or Conversations-style statefulness against the current manual transcript path. Ship it only if latency, cost, and tool replay behavior are at least as good as the current implementation.

## Review Gates

- Run package-level tests for touched packages during the pass.
- Run root `npm test` after JavaScript or TypeScript changes.
- Run `pnpm run lint` and `pnpm run typecheck` before a commit-ready handoff.
- Update README, architecture notes, or changelogs when user-facing configuration or runtime behavior changes.
- Do not add production dependencies without an explicit dependency review.
