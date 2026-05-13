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

## Phase 3: OpenAI Chat Baseline

- [ ] 封装 OpenAI client。
- [ ] 实现非流式普通聊天接口。
- [ ] 明确 message/request/response 的 Pydantic schema。
- [ ] 验证 Responses API 最小调用成功。

## Phase 4: Streaming

- [ ] 实现 FastAPI `StreamingResponse`。
- [ ] 把 OpenAI streaming event 转成前端可读的 SSE。
- [ ] 先只支持文本 delta。
- [ ] 验证前端或 curl 能连续收到 token。

## Phase 5: Agent Loop With Tools

- [ ] 建立 tool registry，把 Python 函数暴露成 Responses API function tools。
- [ ] 支持模型调用 `read_file`。
- [ ] 支持模型调用 `write_file`。
- [ ] 支持模型调用 `run_shell`。
- [ ] 实现 tool call -> 执行工具 -> tool output -> 继续调用模型的循环。
- [ ] 验证一个完整任务：用户要求读文件、模型调用工具、最终回答文件内容。

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
- 下一步：为 Phase 2 写 `docs/notes/phase2.html` 复盘，然后进入 Phase 3 OpenAI Chat Baseline。
