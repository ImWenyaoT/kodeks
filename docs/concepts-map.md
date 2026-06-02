# Kodeks OpenAI Concepts Map

Kodeks is organized as a coding-agent harness around OpenAI concepts rather
than ordinary CRUD domains. This map is the reference for future refactors and
eval coverage.

## Concept Coverage

| OpenAI concept | Kodeks asset | Eval coverage |
| --- | --- | --- |
| Responses-shaped runtime contract | `src/kodeks/providers/bridge.py`, `src/kodeks/responses_tool_loop.py`, `src/kodeks/runtime.py` | `read_file_tool_loop`, `unknown_tool_halts_locally`, `live_basic_completion` |
| Function calling / tools | `src/kodeks/tools/schemas.py`, `src/kodeks/tools/registry.py`, `src/kodeks/agents_runtime.py` | `read_file_tool_loop`, `large_tool_output_becomes_artifact`, `agents_sdk_act_tool_surface`, `live_read_file_tool_loop` |
| Conversation state | `src/kodeks/conversation_state.py`, `src/kodeks/storage/session.py` session/message repositories | `memory_recall_injected`, `live_memory_recall` |
| Context management | `src/kodeks/runtime_context.py`, memory artifact offload in `src/kodeks/storage/memory.py` | `large_tool_output_becomes_artifact`, `memory_recall_injected` |
| Agents SDK | `src/kodeks/agents_runtime.py`, `src/kodeks/agents_events.py` | `agents_sdk_act_tool_surface`, `agents_sdk_plan_tool_surface`, `agents_sdk_approval_pause` |
| Safety and approvals | `src/kodeks/workspace.py`, approval repository/routes in `src/kodeks/storage/session.py` and `src/kodeks/app.py` | `dangerous_shell_requires_approval`, `agents_sdk_approval_pause` |
| Planning | plan-mode instructions in `src/kodeks/runtime_context.py`, plan artifacts in `src/kodeks/plans.py` | `plan_mode_creates_plan_artifact`, `live_plan_mode_artifact` |
| Model routing | `src/kodeks/config.py`, MoonBridge routes in `src/kodeks/app.py`, bridge adapter in `src/kodeks/providers/bridge.py` | `bridge_preflight_missing_provider` |
| Streaming UI transport | `src/kodeks/api/sse.py`, `src/kodeks/api/ui_transport.py`, `/api/chat/ui` | `ui_transport_finish_event` |
| Evals | `evals/run_local.py`, `evals/cases.jsonl`, `evals/live_cases.jsonl` | deterministic lane and optional live lane |

## Refactor Rules

- Keep MoonBridge implicit. It is a protocol adapter that converts
  Chat-Completions-compatible providers into a Responses-shaped runtime path.
  It is important infrastructure, not a user-facing product concept.
- Split files only when the new file maps cleanly to an OpenAI concept and
  reduces local cognitive load.
- Prefer preserving current behavior and proving it with evals before moving
  code.
- Do not add provider directories, one-file-per-tool handlers, custom tracing
  processors, or a generic permission engine until evals show those entities
  are needed.

## Refactor Order

1. Responses tool loop: move function-call continuation state out of the broad
   runtime orchestrator.
2. Agents SDK event normalization: separate SDK event readers from agent
   construction.
3. Conversation state: name transcript replay after the OpenAI concept it
   implements.
4. Model routing: isolate the runtime-path decision while keeping provider
   config in `config.py`.
5. Tool schemas: separate model-facing tool schema definitions from handlers
   if `tools.py` continues to grow.
6. Approval service: only after the earlier splits are stable, extract approval
   creation/audit/execute-once behavior without introducing a full permission
   engine.

## Beginner Reading Path

If you are building the harness mental model first, start with
`docs/harness-reading-map.md`. This concepts map is better as the second pass:
it explains why the implementation boundaries line up with OpenAI concepts and
eval coverage.
