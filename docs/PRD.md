# kodeks PRD

## Product Goal

Kodeks 是一个 local-first coding agent workbench。用户给它一个项目目录后，agent
可以在受控 workspace 内读文件、写文件、跑命令、看验证结果，并通过流式事件把过程展示给前端或 CLI。

产品边界固定为：**带 memory、multi-session、subagent、plan mode 的 coding agent**。
多的功能不做；少的能力要做深。这个 repo 的价值不是复杂 agent system，而是用最小实现体现对 harness 的理解到位。

## Non-Goals

下面这些不属于产品范围：

- web search tools 和搜索 provider 配置。
- provider dashboard 或多 provider 产品面。
- 大型 plugin marketplace。
- 云端托管 agent 平台。
- 独立知识库、RAG dashboard 或 memory 产品。
- 通用多 Agent 编排平台。

可以保留 MCP server manifest discovery，但它是协议集成入口，不是插件市场。

## Harness Evaluation Criteria

所有新功能、重构和文档都要按这六个维度评估。

| Dimension | Kodeks expectation | Evidence |
| --- | --- | --- |
| 状态管理 | session、transcript、memory fact、artifact、plan、approval、subagent run 都有清晰持久化边界。 | SQLite repositories、runtime context injection、transcript replay tests。 |
| 流程控制 | chat turn、tool call、tool result、approval pause、unknown-tool halt、plan-mode filtering 和固定 harness pattern selection 都有确定路径。 | Responses-shaped tool loop、SSE events、eval traces。 |
| 人工审批 | 高风险 shell 不直接执行，必须生成 pending approval；决策一次性、可审计。 | approval routes、audit log、workspace command policy。 |
| 可观测性 | 用户和开发者能看到 agent 正在做什么、为什么暂停、哪里失败、为什么选择某种 harness pattern。 | SSE runtime events、smoke checks、local eval result JSON、audit logs。 |
| 多 Agent | subagent 是受控的 read-only exploration 能力，有 parent session、allowed tools、summary、structured contract 和 durable run record。 | subagent repository、`spawn_explore_agent` tool、eval cases。 |
| 协议集成 | 内部使用 Responses-shaped runtime contract，对 DeepSeek Chat Completions 走 MoonBridge。 | bridge adapter tests、model routing tests、tool-call replay tests。 |

如果一个改动不能增强这些维度中的至少一项，或者会让边界更散，默认不做。

## Current Architecture

- `src/kodeks/app.py` 和 `src/kodeks/api/*_routes.py`: HTTP 入口，只负责请求解析、状态码、route composition 和 SSE。
- `src/kodeks/runtime.py`: chat turn orchestration，负责 session、memory、selected files、plan artifact、tool registry 和完成消息持久化。
- `src/kodeks/harness.py`: 固定的小型 harness pattern selection，只在 `single_turn`、`fanout_synthesize`、`adversarial_verify`、`loop_until_done` 和 `tournament` 之间选择。
- `src/kodeks/responses_runtime.py` 和 `src/kodeks/responses_tool_loop.py`: Responses-shaped stream、tool continuation、terminal errors 和 large tool output offload。
- `src/kodeks/config.py` 和 `src/kodeks/model_config.py`: 用户级配置读取、DeepSeek/MoonBridge model option resolution 和 secret-free model catalog。
- `src/kodeks/providers/bridge.py`: Responses-to-Chat-Completions bridge，负责 DeepSeek stream、tool call chunks、`reasoning_content` 和 terminal failure mapping。
- `src/kodeks/tools/`: deterministic tool registry for workspace, shell, memory, MCP discovery, and explore subagent tools。
- `src/kodeks/workspace.py`: workspace path policy、file service 和 shell harness。
- `src/kodeks/storage/`: SQLite repositories for sessions、messages、plans、memories、approvals、subagent runs 和 audit logs。

## Core Capabilities

### Workspace Tools

- `read_file`: 只读，必须复用 workspace boundary。
- `write_file`: mutating，使用 whole-file overwrite 语义。
- `grep`: 搜索可见 workspace text files。
- `run_shell`: 安全命令可执行；危险命令生成 approval request。

工具能力必须通过 registry 暴露给模型，route 和 provider 不直接执行本地工具。

### Multi-Session State

- 每轮输入写入 transcript。
- assistant text、tool calls 和 tool outputs 可 replay 成下一轮 provider input。
- sessions 可列出、恢复，并记录 workspace root 和 mode。
- forked sessions 可通过 `parentSessionId` 记录来源，但不复制成复杂 branch system。
- selected files 和 recalled memory 会在模型调用前进入 runtime instructions。

### Memory

- memory 只保存可解释、可审计的用户偏好、项目事实和 lessons。
- memory recall 必须暴露 recalled ids/layers，避免静默污染上下文。
- large tool output 使用 artifact ref 压缩，不把全文无脑塞回 prompt。
- memory 不是独立知识库产品；它服务于 coding agent 的连续上下文。

### Plan Mode

- `mode="plan"` 注入 planning 指令。
- plan mode 只暴露 read-only tools。
- assistant plan 会持久化为 active plan artifact。
- 后续 turn 会恢复 active plan 并注入模型上下文。
- 每轮都会选择一个固定 harness pattern，并把理由、stop condition、approval boundary 写入 audit log 和 runtime instructions。

### Human Approval

- shell policy 先判断危险命令。
- pending approval 记录 command、reason、session 和 tool call。
- approve/reject 通过 HTTP route 决策。
- approved command 只执行一次。
- approval_required、approval_executed、approval_rejected 都进入 audit log。

### Subagent

- subagent 先保持 read-only exploration。
- 每个 run 有 parent session、agent name、task、allowed tools、status、summary 和 timestamps。
- subagent 输出必须以 summary 和 `claim`、`evidence`、`risk`、`confidence`、`nextAction` contract 回到主 agent，而不是扩大成独立 agent 平台。

### Observability Discipline

- runtime 是单 controller：它推进 turn、tool、approval、plan 和 subagent 状态。
- audit log 记录 `turn_started`、`harness_pattern_selected`、`tool_called`、`tool_result`、`approval_required`、`plan_checkpointed`、`subagent_started`、`subagent_completed` 和 `turn_completed`。
- UI 可以只展示一部分，但后端必须保留足够事件让 session 复盘。

### Protocol Integration

- Kodeks runtime 消费 Responses-shaped events。
- MoonBridge 把 DeepSeek Chat Completions stream 转成 Responses-shaped event stream。
- tool call chunking、tool result replay、`reasoning_content` 和 `response.failed` 是协议边界的重点。
- MoonBridge 是内部 adapter，不是用户需要理解的 provider 产品面。

## Acceptance Checks

基础验证：

```bash
uv run pytest
uv run ruff check
uv run mypy
uv build
uv run python -m kodeks.smoke --in-process
```

面向 harness 的验收：

- 状态管理：新增状态必须有 repository 或明确持久化边界，并有 replay/recovery 测试。
- 流程控制：新增事件或分支必须有 SSE/event trace 测试。
- 人工审批：任何高风险 side effect 都必须可暂停、可拒绝、可审计。
- 可观测性：失败必须有 user-visible event 或 durable audit/eval artifact。
- 多 Agent：subagent 能力必须证明 read-only allowed tools、structured summary contract 和 parent session 关系。
- 协议集成：provider adapter 变化必须覆盖 stream、tool call、tool output replay 和 terminal error。

## Refactor Rule

默认不为“架构完整感”增加抽象。只有在以下条件满足时才拆文件或加层：

- 它让六个 harness 维度之一更清楚；
- 它减少真实重复或认知负担；
- 它保留当前用户可见行为；
- 它有 focused tests 或 eval case 证明。

这套规则比“做复杂 agent system”更重要。Kodeks 要小，但小得有边界、有证据、有审计、有协议意识。
