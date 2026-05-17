# kodeks

`kodeks` 是一个教学型 Python coding-agent 项目：用 FastAPI、uv、OpenAI Python SDK 和 Responses API，复刻一个 mini opencode/codex 的核心执行链路。

当前目标不是做普通 chatbot，而是逐步搭出 coding agent 的四个核心能力：

- streaming first: `/api/chat/stream` 用 SSE 输出 runtime events。
- event driven: route、runtime、provider 共享一套内部事件协议。
- tool orchestration: 下一阶段从 `read_file` 单工具闭环开始。
- conversation state: 用 `session_id -> previous_response_id` 保存多轮上下文。

## Run

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

Provider configuration:

- `LLM_API_KEY` or `OPENAI_API_KEY`
- optional `LLM_BASE_URL` or `OPENAI_BASE_URL`
- optional `LLM_MODEL`, default `gpt-5.4-mini`

## Test

```bash
uv run python -m compileall -q src tests
uv run python -m unittest discover -s tests -v
```

If the local environment cannot write to the default uv cache, use a temp cache:

```bash
UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m unittest discover -s tests -v
```

## Architecture

- `src/kodeks/api/routes/`: inbound FastAPI routes. Routes translate HTTP/SSE only.
- `src/kodeks/runtime/`: agent runtime contracts, event protocol, session state, and provider interface.
- `src/kodeks/services/api/`: outbound API adapters, currently OpenAI Responses API.
- `src/kodeks/services/`: local workspace and shell capabilities that can become model tools.
- `src/kodeks/schemas/`: HTTP request/response schemas.

Important runtime contracts:

- `ChatStreamEvent`: internal event contract for `text_delta`, `response_completed`, `error`, `tool_call`, and `tool_result`.
- `ChatProviderRequest`: provider-neutral request carrying user input, `previous_response_id`, tool definitions, and tool outputs.
- `SessionStateStore`: storage abstraction for `session_id -> previous_response_id`.

## Current Status

Completed:

- workspace file boundary with blocked internal paths
- shell harness with timeout and dangerous command detection
- streaming Responses API baseline
- persistent conversation state with SQLite
- structured provider/event contracts ready for Phase 5A

Next slice:

`Phase 5A: read_file-only tool loop`

Phase 5A intentionally exposes only `read_file`. `write_file` and `run_shell` stay out of the model tool loop until the project has approval IDs, audit logs, and a stronger command policy.

Teaching note: `docs/notes/phase5a.html`

Acceptance path:

1. User asks the agent to read a workspace file.
2. The model emits a `read_file` tool call.
3. Runtime executes local `workspace_service.read_file`.
4. Runtime emits a `tool_result` SSE event.
5. Runtime sends `function_call_output` back to the provider.
6. Model streams the final answer.
