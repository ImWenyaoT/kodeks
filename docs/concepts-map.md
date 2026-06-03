# Kodeks Harness Concepts Map

Kodeks is organized around a compact coding-agent harness, not ordinary CRUD
domains and not a broad agent platform. This map connects the six review
dimensions to code ownership and eval coverage.

## Dimension Coverage

| Harness dimension | Kodeks assets | Eval / test coverage |
| --- | --- | --- |
| 状态管理 | `src/kodeks/storage/session.py`, `src/kodeks/storage/memory.py`, `src/kodeks/storage/db.py`, `src/kodeks/conversation_state.py`, `src/kodeks/runtime_context.py` | session repository tests, transcript replay tests, session fork tests, `memory_recall_injected`, `large_tool_output_becomes_artifact`, plan artifact tests |
| 流程控制 | `src/kodeks/runtime.py`, `src/kodeks/harness.py`, `src/kodeks/responses_runtime.py`, `src/kodeks/responses_tool_loop.py`, `src/kodeks/api/chat_routes.py`, `src/kodeks/api/sse.py` | `read_file_tool_loop`, `unknown_tool_halts_locally`, stream error tests, tool continuation tests, harness pattern evals |
| 人工审批 | `src/kodeks/workspace.py`, approval repository in `src/kodeks/storage/session.py`, `src/kodeks/api/approval_routes.py`, `src/kodeks/tools/registry.py` | `dangerous_shell_requires_approval`, approval route tests, audit log assertions |
| 可观测性 | SSE event contract in `src/kodeks/api/sse.py`, UI transport in `src/kodeks/api/ui_transport.py`, audit log repository, `evals/run_local.py`, `src/kodeks/smoke.py` | smoke checks, deterministic eval lane, UI transport tests, turn/tool/subagent/harness audit assertions |
| 多 Agent | `src/kodeks/tools/registry.py` explore subagent tool, `src/kodeks/storage/memory.py` `SubagentRepository`, `subagent_runs` table | `subagent_explore_is_bounded`, structured contract assertions, durable run record assertions |
| 协议集成 | `src/kodeks/providers/bridge.py`, `src/kodeks/responses_runtime.py`, `src/kodeks/responses_tool_loop.py` | bridge mapping tests, `reasoning_content` tests, terminal `response.failed`, tool replay tests |

## Boundary Rules

- Keep the public product definition centered on memory, multi-session,
  subagent, plan mode, workspace tools, approvals, observability, and protocol
  adaptation.
- Keep MoonBridge implicit. It is a protocol adapter that converts DeepSeek
  Chat Completions into the Responses-shaped runtime path.
- Do not add web search, provider dashboards, a plugin marketplace, or generic
  multi-agent orchestration.
- Do not add arbitrary workflow scripts. Kodeks only selects from the fixed
  harness patterns in `src/kodeks/harness.py`.
- Do not add provider directories, one-file-per-tool handlers, custom tracing
  processors, skill marketplaces, or a generic permission engine unless evals
  show a concrete harness problem that the new boundary solves.
- Borrow AX-style runtime discipline only in small forms: single controller,
  durable event log, clear resume/fork semantics, and bounded child runs.
- Prefer behavior-preserving refactors backed by focused tests and eval cases.

## Reading Path

1. `docs/architecture.md`: product boundary and main request path.
2. `docs/PRD.md`: six harness dimensions and acceptance checks.
3. `src/kodeks/runtime.py`: turn-level orchestration.
4. `src/kodeks/responses_runtime.py` and `src/kodeks/responses_tool_loop.py`:
   tool continuation and stream control.
5. `src/kodeks/tools/`, `src/kodeks/workspace.py`, and `src/kodeks/storage/`:
   local capability, safety, and state.
6. `src/kodeks/providers/bridge.py`: protocol integration.
