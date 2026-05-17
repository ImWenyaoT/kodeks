# kodeks PRD

目标：实现一个 Python + FastAPI 版 mini opencode/codex，可以作为实习简历项目讲清楚。

## Product Goal

用户给 coding agent 一个项目目录后，agent 可以在受控 workspace 内读文件、写文件、跑命令、看验证结果，并通过流式事件把过程展示给前端或 CLI。

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

- `api/routes`: HTTP 入口，只负责请求解析、状态码和 SSE。
- `runtime`: agent 运行时，负责 session、event contract、provider contract、后续 tool loop。
- `services/api`: outbound model provider adapter，目前是 OpenAI Responses API。
- `services`: workspace/shell 本地能力，后续暴露成 agent tools。

## Current Phase

Phase 0-4 已完成：

- FastAPI + src-layout package
- workspace boundary
- shell harness
- streaming-first event baseline
- SQLite conversation state
- structured event/provider contract for tool orchestration

下一步是 `Phase 5A: read_file-only tool loop`。

## Phase 5A Acceptance Criteria

- provider request 可以携带 `read_file` tool definition。
- OpenAI function call 能被翻译成 `tool_call` runtime event。
- runtime 能执行 `workspace_service.read_file`。
- `read_file` 必须复用 workspace boundary，不能读取 `.git`、`.kodeks`、`.venv` 等内部路径。
- runtime 能发出 `tool_result` SSE event。
- runtime 能把 `function_call_output` 交回 provider。
- 用户最终能看到模型基于文件内容生成的回答。

## Phase 5A Teaching Plan

这一课只训练一个核心能力：agent runtime 如何完成“模型请求工具 -> 本地执行工具 -> 工具结果回给模型 -> 模型继续回答”的闭环。

学生需要讲清楚四个对象：

- `ToolDefinition`: 告诉模型有哪些工具，以及参数 JSON schema。
- `tool_call`: 模型在 stream 中请求本地能力。
- `tool_result`: runtime 把本地执行过程作为事件展示给客户端。
- `function_call_output`: runtime 把工具结果交回 Responses API，让模型继续生成最终答案。

## Deferred From Phase 5A

- `write_file`: 会修改 workspace，需要先设计 overwrite/diff 策略。
- `run_shell`: 会执行任意命令，需要 approval id、audit log、command policy 后再进入模型 tool loop。
- 多工具循环：先把单工具闭环打穿，再抽象多工具调度。

## Out of Scope For MVP

- 多 agent
- 云端 sandbox
- 完整 TUI
- 插件系统
