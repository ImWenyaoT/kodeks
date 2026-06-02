# kodeks PRD

目标：实现一个 mini opencode/codex，可以作为实习简历项目讲清楚。产品能力不变；当前主实现是 Python/FastAPI runtime 加 Python-hosted UI。旧 Next.js/TypeScript shell 已从 active workspace 移除。

## Implementation Status

主链路已经迁回 Python/FastAPI runtime：

- `src/kodeks/app.py`: FastAPI default UI 和 compatibility routes，覆盖 health、models、sessions、approvals、workspace files、bridge preflight、MoonBridge `/v1/responses`、`/api/chat/stream` 和 `/api/chat/ui`。
- `src/kodeks/static/index.html`: Python-hosted browser shell。
- `src/kodeks/runtime.py`: Python chat turn orchestration、event contract、memory injection、plan-mode tool filtering、本地 tool wrappers 和 transcript side effects。
- `src/kodeks/agents_runtime.py`: Python `openai-agents` adapter。
- `src/kodeks/config.py`: OpenAI Responses 与 MoonBridge model option resolution。
- `src/kodeks/tools/`: deterministic tool registry for workspace, shell, memory, and explore subagent tools。
- `src/kodeks/workspace.py`: workspace path policy, file service, and shell harness。
- `src/kodeks/storage/`: SQLite repositories for sessions, messages, memories, approvals, subagent runs, and audit log。
- `src/kodeks/providers/bridge.py`: Responses-to-Chat-Completions bridge，负责 OpenAI Responses DTO、Core IR、Chat Completions adapter。

PRD 的产品目标仍然是 memory、multi-session、plan mode、subagent、workspace tools、shell execution 和 auditable approvals；变化只是 runtime 实现栈已经回到 Python/FastAPI/uv，并明确运行时优先级：Python OpenAI Agents SDK + Responses API 能覆盖的能力先用它，非 Responses provider 统一先经过 MoonBridge 变成 Responses-shaped runtime。

## Product Goal

用户给 coding agent 一个项目目录后，agent 可以在受控 workspace 内读文件、写文件、跑命令、看验证结果，并通过流式事件把过程展示给前端或 CLI。

kodeks 的长期目标从一开始就不是普通 chatbot，而是一个至少具备 memory、multi-session、plan mode、subagent 能力的 coding agent。本文档里的 phase 是实现顺序，不是能力是否属于教案目标的分界线。

## Reference Strategy

kodeks 有四条参考线，优先级不能混：

- Official API/product reference: Python 主链路优先使用 DeepSeek Chat Completions，经 MoonBridge 适配成 Responses-shaped runtime event contract；旧的多 provider/direct provider 不再作为当前产品面。
- Legacy provider reference: 旧 TypeScript OpenAI/Agents SDK backend packages、Next.js shell 和 pnpm workspace 已从当前 workspace 移除；历史行为对照应以提交历史或迁移设计文档为准，而不是维护第二套 runtime。
- Agent design primary reference: 优先参考 `/Users/edward/Documents/src` 的 coding-agent 设计，把成熟产品里的 context window、memory、multi-session、plan mode、tool orchestration、subagent 思路翻译成 Python runtime + Python-hosted UI 实现。
- Agent structure secondary reference: 同时参考 `/Users/edward/Documents/opencode`，尤其是 session、agent、tool、provider abstraction、TUI/session UI 和 plan tool 的组织方式。但当 `/src` 和 `opencode` 的设计取舍不同，默认以 `/src` 为主。

换句话说：agent/runtime 不能停在自研雏形；能用成熟 Responses-shaped 协议和 DeepSeek Chat Completions 的地方优先用它们。Kodeks 自己保留 product boundary：workspace policy、session/memory、approval audit、本地 tools、MCP/skills 配置和事件协议。`src/kodeks/config.py` 只负责把 DeepSeek 配置解析成 MoonBridge client options。

## Agent Reference Map

下表中的 `/Users/edward/Documents/src` 和 `/Users/edward/Documents/opencode`
路径只是设计参考，不是当前 Kodeks 的 active implementation surface。当前实现仍以
`src/kodeks/*` 的 Python runtime 模块为准；不要把参考项目里的 TypeScript 路径当成
本仓库需要恢复的栈。

| Capability                       | API / starter reference                                                                   | Primary agent reference: `/Users/edward/Documents/src`                                                    | Secondary structure reference: `/Users/edward/Documents/opencode`                                                                                                             | kodeks translation                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model streaming / function tools | DeepSeek Chat Completions 经 MoonBridge 适配成 Responses-shaped stream | `services/api/*` outbound adapter 分层                                                                    | `packages/llm/src/protocols/*`, `packages/opencode/src/provider/*`                                                                                                            | runtime 消费 Responses-shaped stream，再映射成 Kodeks `AgentEvent`；MoonBridge 负责把 DeepSeek upstream 统一成 Responses-compatible endpoint。 |
| Context window / compaction      | starter app 只作为多轮 demo，不作为 compaction 设计源                                     | `services/compact/autoCompact.ts`, `services/compact/compact.ts`, `utils/contextSuggestions.ts`           | `packages/app/src/components/session/session-context-*`, `packages/app/src/context/global-sync/session-trim.ts`                                                               | 设计 token threshold、manual/auto compact、tool result bloat warning、post-compact restore，而不是只靠无限 session history。                         |
| Memory                           | starter app 没有长期 memory，不能照搬 session cookie/in-memory token store                | `memdir/findRelevantMemories.ts`, `services/SessionMemory/sessionMemory.ts`, `services/extractMemories/*` | 先作为对照观察 agent/session 数据结构，若 opencode 缺少同等 memory 层，则不强行照搬。                                                                                         | 区分 project/user/session memory；memory recall 要可选择、可审计、有 freshness，不要每轮无脑塞全部记忆。                                             |
| Multi-session / resume           | Chat Completions messages / Responses API input items                                     | `utils/sessionStorage.ts`, `utils/listSessionsImpl.ts`, `remote/RemoteSessionManager.ts`                  | `packages/opencode/src/session/session.ts`, `packages/opencode/src/v2/session.ts`, `packages/opencode/src/share/session.ts`                                                   | `session_id` 不只是 latest response id，还要逐步支持 transcript、metadata、resume、project/worktree scope。                                          |
| Plan mode                        | starter app 无 plan mode                                                                  | `utils/plans.ts`, `components/permissions/AskUserQuestionPermissionRequest/*`, `tools/ExitPlanModeTool/*` | `packages/opencode/src/tool/plan.ts`, `packages/opencode/src/tool/plan-enter.txt`, `packages/opencode/src/tool/plan-exit.txt`, `test/agent/plan-mode-subagent-bypass.test.ts` | plan 要有文件/状态载体、clarifying interview、退出 plan mode、resume 恢复，而不是临时字符串。                                                        |
| Tool orchestration               | Chat Completions tool_calls / Responses API function_call items                           | `services/tools/toolOrchestration.ts`, `services/tools/toolExecution.ts`, `Tool.ts`                       | `packages/opencode/src/tool/tool.ts`, `packages/llm/src/tool-runtime.ts`, `packages/llm/src/protocols/utils/tool-stream.ts`                                                   | runtime 负责 tool loop；只读工具可并发，高风险/会改状态的工具串行并走 permission/approval。                                                          |
| Subagent / forked work           | starter app 无 subagent                                                                   | `utils/forkedAgent.ts`, `hooks/useSwarmInitialization.ts`, `types/logs.ts`                                | `packages/opencode/src/agent/agent.ts`, `packages/opencode/src/agent/subagent-permissions.ts`, `packages/opencode/test/cli/run/subagent-data.test.ts`                         | 子代理要隔离输入上下文、输出摘要、session/log 标识，并把结果回填到主计划。                                                                           |

## MVP

- streaming chat endpoint
- conversation state
- workspace 内文件列表
- `read_file`
- `write_file`
- `run_shell`
- tool call / tool result event contract
- 危险命令 approval

MVP 不是一次性把所有能力都暴露给模型。课程顺序必须先完成只读 tool loop，再逐步接入会修改状态或执行命令的工具。

## Current Architecture

- `src/kodeks/app.py`: HTTP 入口，只负责请求解析、状态码和 SSE。
- `src/kodeks/runtime.py` 和 `src/kodeks/agents_runtime.py`: OpenAI Agents SDK 主运行时，负责 session、event contract、approval pause、tool wrappers 和 model/tool continuation。
- `src/kodeks/config.py`: DeepSeek/MoonBridge model option resolution；DeepSeek Chat Completions 通过 MoonBridge 作为 upstream 接入，不作为第二套 runtime 暴露。
- `src/kodeks/workspace.py`、`src/kodeks/tools/`、`src/kodeks/storage/`: workspace/shell 本地能力、tool registry 和 durable state。

## Current Phase

Phase 0-6 已完成：

- FastAPI + src-layout package
- workspace boundary
- shell harness
- streaming-first event baseline
- SQLite conversation state
- structured event/provider contract for tool orchestration
- read-file-only tool loop
- mutating `write_file` tool with whole-file overwrite semantics
- `run_shell` tool with pending approval audit records for dangerous commands
- approval status, approve, and reject APIs

Phase 7-9 的最小闭环已落地：

- `long-term memory`: `.kodeks/memory.jsonl` 追加式保存记忆，runtime 会按当前输入召回相关 memory 并显式注入 provider input；同时暴露 `remember_fact` / `recall_memory` tools。
- `multi-session resume`: SQLite session store 保存最小 transcript，并保留 latest completion id 作为旧客户端兼容字段，支持后续 resume UI/API 扩展。
- `plan mode`: `ChatStreamRequest.mode="plan"` 会注入 plan-mode 指令，并只暴露非 mutating tools，避免模型在规划阶段写文件或跑 shell。
- `subagent`: 暴露 `spawn_subagent` tool，用隔离 task/context 生成可审计 summary，并写入 `.kodeks/subagents.jsonl`。

下一步是把这些最小能力产品化：memory freshness/删除、session listing/resume API、plan artifact、真正 nested subagent runtime。

## Core Agent Capability Teaching Roadmap

kodeks 的课程路线围绕 coding agent 的核心能力组织。当前不要求一次性全部实现，但教案必须让每个能力都有清楚的位置、验收边界和面试表达。

| Component               | Teaching Phase  | Current Status                                               | Teaching Boundary                                                                                                                    |
| ----------------------- | --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol                | Phase 3         | 已实现基础事件协议                                           | 统一 runtime 内部事件，HTTP/SSE、未来 CLI/TUI 都消费同一套 `ChatStreamEvent`。                                                       |
| Multi-session / Context | Phase 4         | 已实现 conversation state + 最小 transcript                  | 用 user/assistant transcript 组装 provider input，兼容 Chat Completions messages 和 Responses API input items。                      |
| Tools                   | Phase 1/2/5A/5B | `read_file`、`write_file`、`run_shell` 已进入模型 tool loop  | workspace/shell 先作为安全 service 被验证，再通过 registry 暴露给模型；危险 shell 只生成 approval request。                          |
| Approval                | Phase 5B/6      | 已实现 pending approval、approve/reject API 和一次性恢复执行 | Phase 5B 只负责暂停和记录；Phase 6 负责人类决策和执行恢复，但不做 once/always 持久规则。                                             |
| Memory                  | Phase 4/7       | 已实现最小 JSONL memory + 自动 recall + memory tools         | 区分最小可审计 memory 与完整 memory lifecycle；后续再做 freshness、删除、压缩和来源 UI。                                             |
| Planning / Plan mode    | Phase 8         | 已实现最小 runtime plan mode                                 | `mode="plan"` 注入 planning 指令并过滤 mutating tools；后续再做 plan artifact、clarifying interview、退出 plan mode 和 resume 恢复。 |
| Subagent                | Phase 9         | 已实现最小 subagent tool                                     | 用独立 task/context 生成本地 summary 和审计日志；后续再升级为真正 forked model runtime、并行执行和结果回填。                         |

这个顺序故意把 `protocol -> multi-session context -> tools -> approval -> memory -> planning -> subagent` 拆开：目标能力早已确定，阶段顺序只是为了先建立可观察、可验证、安全的 runtime，再逐步增强自治能力。

所有 Phase 7 之后的设计都要先做一次 `/Users/edward/Documents/src` 对照阅读，再用 `/Users/edward/Documents/opencode` 做结构交叉检查；涉及 model API、streaming、function tools 时，同时对照 DeepSeek Chat Completions 与 OpenAI Responses API 官方文档。不要从零发明一套看起来像 agent、但没有成熟产品边界的抽象。

## Phase 5A Acceptance Criteria

- [x] provider request 可以携带 `read_file` tool definition。
- [x] Provider tool call 能被翻译成 `tool_call` runtime event。
- [x] runtime 能执行 `workspace_service.read_file`。
- [x] `read_file` 必须复用 workspace boundary，不能读取 `.git`、`.kodeks`、`.venv` 等内部路径。
- [x] runtime 能发出 `tool_result` SSE event。
- [x] runtime 能把 tool result message 交回 provider。
- [x] 用户最终能看到模型基于文件内容生成的回答。

## Phase 5A Teaching Plan

这一课只训练一个核心能力：agent runtime 如何完成“模型请求工具 -> 本地执行工具 -> 工具结果回给模型 -> 模型继续回答”的闭环。

学生需要讲清楚四个对象：

- `ToolDefinition`: 告诉模型有哪些工具，以及参数 JSON schema。
- `tool_call`: 模型在 stream 中请求本地能力。
- `tool_result`: runtime 把本地执行过程作为事件展示给客户端。
- `tool result continuation`: runtime 把工具结果交回 provider，让模型继续生成最终答案。

## Deferred From Phase 5A

- `write_file`: 会修改 workspace，需要先设计 overwrite/diff 策略。
- `run_shell`: 会执行任意命令，需要 approval id、audit log、command policy 后再进入模型 tool loop。
- 多工具循环：先把单工具闭环打穿，再抽象多工具调度。

## Phase 5B Acceptance Criteria

- [x] registry 同时暴露 `read_file`、`write_file`、`run_shell` 三个工具定义。
- [x] `write_file` 使用 whole-file overwrite 语义，不做隐式 patch；tool result 返回 `strategy`、`overwritten`、`bytes_written`。
- [x] `write_file` 继续复用 workspace boundary，不能写 `.git`、`.kodeks`、`.venv` 等内部路径。
- [x] `run_shell` 安全命令复用 `shell_service.run_command`，并把 stdout、stderr、exit code 结构化返回给模型。
- [x] 危险 shell 命令、内部路径访问和明显路径逃逸不执行，返回 `tool_status="approval_required"`、`approval_id` 和 pending 状态。
- [x] 危险 shell 命令写入 `.kodeks/tool_audit.jsonl`，记录 session、tool call、命令摘要、原因和 pending 状态。
- [x] runtime 仍然只负责编排：收 tool_call、执行 registry、发 tool_result、回传 tool message；route 和 provider 不执行本地工具。

## Phase 5B Teaching Plan

这一课训练的是“工具风险分级”：

- `read_file`: read-only，可直接执行，但仍复用 workspace boundary。
- `write_file`: mutating，但风险被限制在 workspace 内；第一版选择 whole-file overwrite，因为语义清晰、测试容易、面试里好解释。
- `run_shell`: 最高风险；安全命令可以执行，危险命令必须 pause 成 approval request 并写 audit trail。

Phase 5B 的面试讲法：我没有把 shell 直接暴露给模型，而是把所有工具统一进 registry，再按风险分级处理。这样 runtime 能保持稳定，权限系统也有清晰扩展点。

## Deferred From Phase 5B

- 更细粒度的 approve/reject 分路 HTTP API。
- approval 后恢复执行原始命令的前端体验增强。
- once/always/reject 持久规则。
- diff-based edit tool。
- 更强 shell parser、prefix allowlist、sandbox 和长任务进程管理。

## Phase 6 Acceptance Criteria

- [x] approval service 可以按 `approval_id` 读取最新状态。
- [x] `POST /api/approvals/{approval_id}` 携带 `decision="approve"` 时能批准 pending shell approval，并执行原始命令一次。
- [x] `POST /api/approvals/{approval_id}` 携带 `decision="reject"` 时能拒绝 pending shell approval，且不会执行命令。
- [x] `GET /api/approvals/{approval_id}` 能返回 approval 最新状态。
- [x] 已 approved / rejected / executed 的 approval 不能再次执行，重复处理返回冲突。
- [x] 不存在的 `approval_id` 返回 not found，批准命令超时返回 timeout。
- [x] audit log 追加 `approved`、`executed`、`rejected` 或 `execution_timeout` 记录，保留 Phase 5B 的 pending 记录。

## Phase 6 Teaching Plan

这一课训练的是 permission system 的第一版产品化：

- Phase 5B 的 `approval_required` 只是把危险动作暂停下来。
- Phase 6 让人类可以对 pending approval 做一次性决策。
- 批准后恢复执行必须仍然在受控 workspace、timeout 和审计链路里进行。
- 拒绝后要把拒绝原因记录下来，后续 agent 才能解释为什么不能继续。

Phase 6 的面试讲法：我把“模型想执行危险命令”转成了可审计的人类决策流。模型不能绕过审批；审批只能消费一次；每一步都有日志，这就是 coding agent 从 demo 走向真实产品的关键边界。

## Deferred From Phase 6

- `allow once` / `always allow` / `always deny` 的持久规则。
- Web/TUI permission prompt。
- 复杂 shell parser、prefix allowlist 和 sandbox。
- approval 结果自动回灌正在等待的 agent stream。
- 多进程/多 worker 下的并发锁。

## Post-Approval Teaching Backlog

Phase 5A/5B/6 解决“agent 能不能安全地调用工具”。之后的课程会进入更像真实 coding agent 的自治能力：

- `long-term memory`: 只保存可解释、可审计的用户偏好、项目事实和 lessons，避免模型静默污染永久状态。
- `context assembly`: 把 session state、project memory、工具观察结果组合成下一轮模型输入，但继续和 RAG 保持概念边界。
- `planning`: 为复杂任务生成可更新计划，失败时 re-plan，把 plan 变化作为事件或审计记录暴露出来。
- `subagent`: 把独立探索、并行分析或验证工作拆给子代理，再由主 agent 汇总成下一步计划。
- `evaluation`: 用固定任务验证 plan/tool/memory 是否真的提升成功率，而不是只看 demo 是否顺利。

## Out of Scope For MVP

- 多 agent
- 云端 sandbox
- 完整 TUI
- 插件系统
