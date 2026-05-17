# kodeks Build Roadmap

目标：用 Python、FastAPI、uv、OpenAI SDK Python、Responses API 做一个能写进实习简历的 mini opencode/codex。

## Phase 0: Project Shape

- [x] 建立 `src/kodeks/` Python package layout。
- [x] 建立 FastAPI app 入口。
- [x] 建立 `core/`、`schemas/`、`services/`、`tools/`、`api/routes/` 目录。
- [x] 加一个 `/health` 接口验证项目能启动。
- [x] 用 `uv run fastapi dev src/kodeks/main.py` 或等价命令跑起来。

## Phase 1: Workspace Tools Without AI

- [x] 实现 workspace root 配置。
- [x] 实现安全路径解析，只允许访问 workspace 内文件。
- [x] 实现文件列表接口。
- [x] 实现 `read_file` 工具。
- [x] 实现 `write_file` 工具。
- [x] 为路径逃逸、文件不存在、写入成功补测试或手动验证记录。

## Phase 2: Shell Harness Without AI

- [x] 实现 `run_shell` 服务，使用受控工作目录执行命令。
- [x] 实现命令超时、stdout、stderr、exit code 返回。
- [x] 实现危险命令识别。
- [x] 危险命令先返回 `approval_required`，不直接执行。
- [x] 为安全命令和危险命令补验证记录。

## Phase 3: Streaming-First OpenAI Event Baseline

- [x] 阅读官方 Responses API streaming 与 conversation state 文档，并确定本项目第一版 event contract。
- [x] 新建 OpenAI client/service 层，让 API route 不直接依赖 SDK 细节。
- [x] 明确 request schema：`input`、可选 `previous_response_id`、可选 `session_id`。
- [x] 明确 stream event schema：`text_delta`、`response_completed`、`error`，先预留 `tool_call` / `tool_result` 事件类型。
- [x] 实现 FastAPI `StreamingResponse`，把 OpenAI streaming event 转成前端可读的 SSE。
- [x] 先只支持纯文本 delta，不接工具调用。
- [x] 在完成事件里返回 `response_id`，为后续 conversation state 做准备。
- [x] 处理缺少 `OPENAI_API_KEY` 的错误，让失败信息对开发者可读。
- [x] 用 curl 验证能连续收到 SSE event，并记录真实请求结果或环境阻塞原因。

## Phase 4: Conversation State

- [x] Phase 4 开工前先做一次小型 architecture cleanup，不改变行为，只把职责边界想清楚。
- [x] 新建 `runtime/` 或等价模块，承载 agent runtime 层概念：session state、event contract、后续 tool loop。
- [x] 新建 `services/api/`，参考 Claude Code 的 `services/api` 形态，把 OpenAI Responses API 这类外部 API client 从业务 runtime 中隔离出来。
- [x] 设计 `session_id -> previous_response_id` 的最小状态存储。
- [x] 默认使用 SQLite 持久化 `session_id -> previous_response_id`；保留内存 store 作为测试/轻量注入实现。
- [x] 支持用户带 `session_id` 连续对话。
- [x] 支持用户显式传入 `previous_response_id`。
- [x] 定义冲突规则：用户显式传入 `previous_response_id` 时优先于服务端 session store。
- [x] 在 `response_completed` 后把 `session_id -> response_id` 写回 store。
- [x] 增加可选 `session_created` 或等价响应信息，让客户端知道新 session id。
- [x] 明确何时由客户端保存 state，何时由服务端保存 state。
- [x] 验证第二轮请求能延续第一轮上下文。
- [x] 为 session store 补单测：新会话、已有会话、显式 previous override、完成后更新、错误不更新。
- [x] 为 `/api/chat/stream` 补接口级测试：同一个 `session_id` 第二轮会自动带上第一轮 `response_id`。
- [x] 写 Phase 4 复盘笔记：业务需求、架构边界、面试讲法、和 memory/RAG 的区别。

### Phase 4 Teaching Focus

- 学会区分三种状态：OpenAI 的 `previous_response_id`、kodeks 自己的 `session_id`、未来长期 memory。
- 学会高内聚低耦合：route 不知道 OpenAI 细节，runtime 不知道 HTTP/SSE，`services/api` outbound client 不知道业务 session 策略。
- 学会面试表达：conversation state 解决的是“连续任务上下文”，memory 解决的是“跨任务长期偏好/事实”，RAG 解决的是“外部知识注入”，三者不能混成一个概念。
- 学会工程取舍：SQLite 可以作为 Phase 4 的合理默认实现，因为它让 session state 跨进程重启保留；真正要避免的是让 runtime/route 直接依赖 SQLite 细节。
- 学会把 Phase 4 讲成真实业务问题：用户在 coding agent 中连续给指令时，系统必须记住上一轮模型响应，否则每一轮都会退化成一次性问答，无法支撑多步修代码。

### Phase 4 Concrete Implementation Plan

- [x] 新建 `runtime/session_state.py`，定义 `SessionStateStore`、`InMemorySessionStateStore` 和 `SQLiteSessionStateStore`。
- [x] `InMemorySessionStateStore` 内部维护 `dict[str, str]`，`SQLiteSessionStateStore` 使用本地 SQLite 持久化 `session_id -> previous_response_id`。
- [x] 给 store 提供 `get_previous_response_id(session_id)`、`set_previous_response_id(session_id, response_id)`、`clear(session_id)`。
- [x] 在 `ChatRuntime` 构造函数中接收可选 `session_store`；runtime 单独使用时默认内存 store，FastAPI route 注入 SQLite store。
- [x] 在 `ChatRuntime.stream_chat()` 里解析本轮 `previous_response_id`：显式 request 值优先，其次读 session store。
- [x] 如果 request 没带 `session_id`，生成新的 session id，并通过 event 或响应字段告知调用方。
- [x] 当收到 `response_completed` 且本轮有 `session_id` 时，把 `response_id` 写回 session store。
- [x] 当收到 `error` 时不更新 session store，避免把失败 turn 当成有效上下文。
- [x] 扩展 `ChatStreamEvent`，让必要事件能携带 `session_id`。
- [x] 补 store 单测：新会话、已有会话、clear、覆盖更新、SQLite 跨实例持久化。
- [x] 补 runtime 单测：显式 `previous_response_id` 优先、session store fallback、completed 后更新、error 不更新。
- [x] 补 route/SSE 测试或 curl 验证：同一个 `session_id` 第二轮请求会自动续上第一轮 `response_id`。
- [x] 更新 `docs/notes/phase4.html`，按真实业务问题、方案取舍、边界、验证、面试表达复盘。
- [x] 面试讲法：我把 OpenAI 的 `previous_response_id` 包成自己的 session runtime，让 coding agent 从 single-turn stream 升级成 multi-turn workflow；这展示了我能把 API 能力产品化，而不是只会调用模型。

## Phase 5A: Read-file-only Tool Loop

课程目标：先做一个最小、完整、可验证的 agent tool loop。只暴露 `read_file`，让模型能提出工具调用，runtime 执行本地读取，再把 `function_call_output` 回传给模型生成最终回答。

- [ ] 建立最小 tool registry，只注册 `read_file`。
- [ ] 定义 `read_file` tool schema，并通过 provider adapter 发给 Responses API。
- [ ] 在 runtime 中捕获 `tool_call` event，并按 `tool_name` 找到本地工具。
- [ ] 执行 `workspace_service.read_file`，复用现有 workspace path boundary 和 `.kodeks` / `.git` blocklist。
- [ ] 向客户端发出 `tool_result` SSE event，让用户看到 agent 做了什么。
- [ ] 把 `function_call_output` 连同 `previous_response_id` 回传给 provider，继续 streaming 最终回答。
- [ ] 验证一个完整任务：用户要求读文件、模型调用 `read_file`、最终回答文件内容。

### Phase 5A Teaching Focus

- 学会区分 `tool definition`、`tool_call event`、本地 `tool execution`、`function_call_output` 四个概念。
- 学会为什么 tool loop 必须由 runtime 编排，而不是 route 或 provider 自己偷偷执行。
- 学会把安全边界复用到 agent tool：工具不是新的文件系统入口，而是 `workspace_service.read_file` 的模型调用包装。
- 学会小步交付：先完成只读闭环，再谈写文件、跑命令和 approval。

## Phase 5B: Mutating Tools And Shell Preparation

- [ ] 支持模型调用 `write_file`，但要先明确 diff / overwrite 策略。
- [ ] 支持模型请求 `run_shell` 前，先补 command policy、approval id、审计记录。
- [ ] 把危险 shell 命令 pause 成 approval flow，而不是直接执行或只靠 regex。
- [ ] 验证 `write_file`、`run_shell` 都不会绕过 workspace boundary 和 approval boundary。

## Phase 6: Approval Flow

- [ ] 为危险 shell 命令生成 approval id。
- [ ] 增加批准/拒绝接口。
- [ ] 批准后继续执行原命令。
- [ ] 拒绝后把结果返回 agent loop。
- [ ] 验证 `rm -rf` 类命令不会绕过 approval。

## Phase 7: Resume Polish

- [ ] README 写清楚项目目标、架构图、运行方式。
- [ ] 录一个端到端 demo 场景。
- [ ] 补关键测试。
- [ ] 整理和 `openai-responses-starter-app` / opencode 的架构映射说明。
- [ ] 准备面试讲法：agent loop、tool registry、workspace sandbox、approval。

## Review

- 2026-05-17 教案、课程安排和笔记同步计划：
  - [x] 把 Phase 5 课程安排拆成 `Phase 5A: read_file-only tool loop` 和后续 tool 扩展，避免一次性铺开所有工具。
  - [x] 更新 PRD，让 MVP/Current Phase/Acceptance Criteria 和最新安全边界一致。
  - [x] 更新 Phase 4 复盘 handoff，明确 shell/write_file 暂不进入 Phase 5A。
  - [x] 新增 Phase 5A 教案笔记，覆盖业务需求、课程目标、实现步骤、验证方式、面试讲法。
  - [x] 跑文档/测试验证，记录结果。
  - 验证记录：`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m compileall -q src tests` 通过；`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m unittest discover -s tests -v` 通过 28 个测试；`python3 -m html.parser docs/notes/phase1.html docs/notes/phase2.html docs/notes/phase3.html docs/notes/phase4.html docs/notes/phase5a.html` 通过；`git diff --check` 通过。

- 2026-05-17 follow-up review issues 修复计划：
  - [x] 阻止 workspace 工具暴露 `.kodeks/session_state.sqlite3` 等 runtime 私有状态。
  - [x] 让 OpenAI Responses function tool schema 在 `strict=True` 时自动满足 strict schema 基础约束。
  - [x] 避免 `ChatRuntime` 原地修改 provider 产出的 event。
  - [x] 明确 Phase 5A 只接 `read_file`，`run_shell` 等到 approval/audit 边界更完整后再暴露。
  - [x] 补对应测试并跑 `compileall`、完整 unittest、`git diff --check`。
  - 验证记录：`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m compileall -q src tests` 通过；`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m unittest discover -s tests -v` 通过 28 个测试；`git diff --check` 通过；`list_files()` 已不再返回 `.kodeks` 路径。

- 2026-05-17 P1 code review 修复计划：
  - [x] 强化 `ChatStreamEvent`，让 `tool_call` / `tool_result` 有明确字段和校验，不再只是松散预留 type。
  - [x] 升级 `ChatProvider` interface，用结构化 provider request 承载 `input`、`previous_response_id`、未来 tool definitions 和 tool outputs。
  - [x] 拆分测试文件，并补齐 workspace/shell service 的安全边界测试。
  - [x] 给 src-layout 项目补稳定测试入口，让 `uv run python -m unittest discover -s tests -v` 不需要手写 `PYTHONPATH=src`。
  - [x] 补 README/PRD，写清楚运行方式、测试方式、架构分层和下一步 Phase 5A 边界。
  - [x] 验证 `compileall`、默认 unittest、关键行为测试全部通过。
  - 验证记录：`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m compileall -q src tests` 通过；`env UV_CACHE_DIR=/private/tmp/uv-cache uv run python -m unittest discover -s tests -v` 通过 25 个测试；`git diff --check` 通过。
  - 沙箱边界：当前 Codex 沙箱不能写 `/Users/edward/.cache/uv`，所以验证命令使用临时 `UV_CACHE_DIR`；项目自身已通过可安装 package 配置消除了手写 `PYTHONPATH=src` 的要求。

- 2026-05-14 Phase 3 结构重排计划：
  - [x] 拆出 `runtime/events.py`，让 kodeks 自己的 stream event contract 不再放在 API schema 里。
  - [x] 拆出 `services/api/openai_responses.py`，让 OpenAI Responses API 细节不再混在业务 runtime 或 FastAPI route 里。
  - [x] 拆出 `runtime/chat_runtime.py`，让 route 只依赖 runtime，不直接依赖 OpenAI adapter。
  - [x] 更新测试，确认重排后缺 key、正常 stream、空 stream、incomplete、无 terminal event、SSE 序列化仍然通过。
  - [x] 按 `tasks/lessons.md` 补 Phase 3 相关代码顶部 q&a，并新增 `docs/notes/phase3.html`。
  - [x] 验证记录：`compileall` 通过，`unittest discover -s tests -v` 通过 6 个测试，`uvicorn + curl` 验证 `/health` 和 `/api/chat/stream` 缺 key SSE error 正常。

- 2026-05-14 Claude Code 结构对齐记录：
  - [x] 将 `providers/openai_responses.py` 调整为 `services/api/openai_responses.py`，因为 `/Users/edward/Documents/src/services/api` 中的 `api` 代表 outbound API client，而 kodeks 的 `api/routes` 代表 inbound FastAPI route。
  - [x] 更新代码 import、测试、Phase 3 notes 和 roadmap 文档，避免继续混用 `providers` 说法。
  - [x] 重新跑 `compileall`、unit tests、`uvicorn + curl`，证明这是结构调整而非行为改变。

- 2026-05-14 Phase 3 验收计划：
  - [x] 对照 OpenAI 官方 Responses streaming / conversation state 文档复核 event contract。
  - [x] 复查 `openai_service`、`chat` route、schema、app wiring 的高内聚低耦合边界。
  - [x] 跑本地静态/编译/接口验证，重点验证缺 key、空 stream、正常 stream、`previous_response_id` 透传。
  - [x] 给出面向简历项目的阶段判断：哪些是必须做，哪些是面试知识点但不应污染主架构。

- 2026-05-14 Phase 4 验收记录：
  - [x] 纠正对 SQLite 的误判：Phase 4 默认使用 SQLite 持久化 session state，InMemory 只作为测试/轻量替换实现。
  - [x] 修复 `api/routes/chat.py` 中不存在的 `OpenAIResponsesClient` 引用，并让 route 复用进程级 `chat_runtime`。
  - [x] 移除 `schemas/chat.py` 中重复定义的 runtime event schema，保持 request schema 与 runtime event contract 分离。
  - [x] 补齐教练负责的测试：store、runtime、route、provider 共 13 个测试，其中包括 SQLite 跨实例持久化。
  - [x] 验证记录：`compileall` 通过，`unittest discover -s tests -v` 通过 13 个测试，`uvicorn + curl` 验证 `/health`、带 session 的 SSE error、自动 `session_created` 均正常。

- 当前状态：Phase 0 已完成。`src/kodeks/` package、FastAPI app、route 拆分、`/health` 都已跑通。
- 验证记录：`env PYTHONPATH=src UV_CACHE_DIR=/tmp/uv-cache uv run python -m uvicorn kodeks.main:app --port 8010` 启动成功，`curl http://127.0.0.1:8010/health` 返回 `{"status":"ok"}`。
- Phase 1 当前状态：workspace root 已指向 repo 根目录，`/api/workspace/files` 已能返回过滤后的相对文件列表。
- 当前工程意义：已经做出 coding agent 的第一层 workspace boundary，让后续 agent 不直接面对整台机器文件系统。
- `read_file` 验证记录：`README.md` 返回 200，`missing.txt` 返回 404，`../../.ssh/id_rsa` 返回 403。
- 面试表达：我把模型可操作范围限制在 workspace 内，通过 resolved path containment check 防止路径逃逸。
- `write_file` 验证记录：临时 workspace 内 `output/probe.txt` 写入成功并可读回，`../../.ssh/id_rsa` 返回 403，`.git/config` read/write 均返回 403。
- Phase 1 完成态：list/read/write 已共用 workspace containment + internal path blocking 策略。
- Phase 1 复盘文档：`docs/notes/phase1.html` 已记录业务需求、架构设计、安全边界、验证结果和面试表达。
- Phase 2 当前状态：基础 shell harness 已能在 workspace root 执行命令，并返回 command、exit_code、stdout、stderr。
- Phase 2 验证记录：`pwd` 返回 workspace root，`ls` 返回项目文件，长时间命令返回 408 timeout。
- 危险命令验证记录：`rm -rf`、`rm -fr`、`sudo`、`git reset --hard`、`git clean -fd`、`chmod -R`、`curl | sh/bash`、`wget | sh/bash` 均返回 `approval_required=true`，不执行。
- Phase 2 完成态：shell harness 已具备受控工作目录、timeout、结构化输出和第一版危险命令拦截。
- Phase 2 复盘文档：`docs/notes/phase2.html` 已记录 shell harness 的业务需求、架构设计、安全边界、验证结果和面试表达。
- 路线纠偏：因为本项目目标是 coding agent，不是普通 chatbot，所以 Phase 3 改为 streaming-first event baseline。第一版就要建立 SSE event contract，但暂时不接工具；Phase 4 再补 conversation state，Phase 5 再做 tool orchestration。
- Phase 3 当前状态：`/api/chat/stream`、OpenAI service、chat schema 的 streaming-first baseline 已完成；route 只负责 SSE，service 负责 OpenAI event 翻译，schema 固化 kodeks event contract。
- Phase 3 修复记录：补上 `response.incomplete`、空 stream、无 terminal event 的 error event；移除 5 秒 SDK timeout 硬编码；默认模型改为当前官方文档中更适合低延迟/低成本 coding baseline 的 `gpt-5.4-mini`，仍可由 `LLM_MODEL` 覆盖。
- Phase 3 验证记录：`env PYTHONPATH=src UV_CACHE_DIR=/tmp/uv-cache uv run python -m compileall -q src tests` 通过；`env PYTHONPATH=src UV_CACHE_DIR=/tmp/uv-cache uv run python -m unittest discover -s tests -v` 通过 6 个测试。
- Phase 3 curl 验证记录：`uvicorn kodeks.main:app --port 8011` 后，`GET /health` 返回 `{"status":"ok"}`，缺 key 场景 `POST /api/chat/stream` 返回 SSE `event: error` 和 `LLM_API_KEY or OPENAI_API_KEY is not set`。
- Phase 3 真实环境边界：本轮没有消耗真实 OpenAI key；真实 provider 验证仍需要兼容 Responses API streaming 的 base URL。若使用非官方 proxy，必须确认其支持 `/v1/responses`、`stream=true`、`previous_response_id` 和 semantic events。
- 面试表达：这一阶段不是做 chatbot，而是在定义 coding agent runtime 的外部事件协议。后面无论接 memory、session、tool call、approval，前端/CLI 都消费同一套 `text_delta / response_completed / error / tool_call / tool_result` 事件。
