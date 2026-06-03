# Harness Reading Map

Use this page as the first pass for understanding the codebase. Kodeks is an
agent harness: the LLM is external, and the harness is the code that gives the
model state, tools, safety rules, UI transport, and evals.

## Core Mental Model

```text
user / web UI
  -> api routes and SSE transport
  -> runtime orchestration
  -> model provider or MoonBridge adapter
  -> tool calls
  -> workspace policy and durable storage
  -> transcript, memory, plans, approvals, audit log, eval evidence
```

## Read By Capability

| Capability | What it means in this harness | Read first | Then read |
| --- | --- | --- | --- |
| Memory | The agent can store facts, recall them, and offload large tool output into artifacts. | `src/kodeks/storage/memory.py` | `src/kodeks/tools/registry.py`, `src/kodeks/runtime_context.py`, `evals/cases.jsonl` |
| Multi-session | Conversations have durable sessions, transcripts, modes, and parent session ids. | `src/kodeks/storage/session.py` | `src/kodeks/app.py`, `src/kodeks/conversation_state.py` |
| Subagent | The current MVP records a read-only child run, allowed tools, parent session, and auditable summary. | `src/kodeks/storage/memory.py` | `src/kodeks/tools/registry.py`, `docs/concepts-map.md` |
| Plan mode | The agent can create and persist a plan artifact, with a read-only tool surface. | `src/kodeks/plans.py` | `src/kodeks/storage/session.py`, `src/kodeks/runtime_context.py` |
| Event log | Runtime actions are written as durable audit rows so a session can be replayed or explained. | `src/kodeks/storage/session.py` | `src/kodeks/runtime.py`, `src/kodeks/responses_tool_loop.py`, `src/kodeks/tools/registry.py` |

## Read By Ownership Area

| Area | Files | Why it exists |
| --- | --- | --- |
| API and UI transport | `src/kodeks/app.py`, `src/kodeks/api/`, `src/kodeks/static/index.html` | Accept browser requests and stream agent events back to the GUI. |
| Runtime | `src/kodeks/runtime.py`, `src/kodeks/responses_runtime.py`, `src/kodeks/responses_tool_loop.py`, `src/kodeks/conversation_state.py`, `src/kodeks/runtime_context.py` | Turn session state plus user input into model calls, tool continuations, and persisted events. |
| Tools | `src/kodeks/tools/`, `src/kodeks/workspace.py` | Define what the model may call and enforce local workspace/shell boundaries. |
| Storage | `src/kodeks/storage/` | Keep durable sessions, approvals, plans, memory, subagent runs, schema, and row mapping in one package. |
| Providers | `src/kodeks/config.py`, `src/kodeks/model_config.py`, `src/kodeks/providers/` | Load user config, resolve model options, and keep MoonBridge as an implicit protocol adapter. |
| Evals | `evals/` | Prove harness behavior with deterministic cases plus optional live model cases. |

## Suggested First Tour

1. Start with `src/kodeks/runtime_context.py` to see the agent contract.
2. Read `src/kodeks/tools/schemas.py`, then skim handlers in `src/kodeks/tools/registry.py`.
3. Read `src/kodeks/storage/session.py` and `src/kodeks/storage/memory.py` to see what survives between turns.
4. Read `src/kodeks/runtime.py` only after the smaller pieces above; it is the conductor. Then read `src/kodeks/responses_runtime.py` for the Responses-shaped tool loop.
5. Run `uv run python evals/run_local.py` and connect each passing case back to this map.
