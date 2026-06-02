# Kodeks 架构说明

Kodeks 是一个 local-first 的 coding agent workbench。当前默认用户界面由 Python/FastAPI 直接服务，chat/runtime 后端也已经迁到 Python OpenAI SDK。旧 TypeScript OpenAI/Agents SDK backend packages、Next.js shell、pnpm workspace 和 TypeScript tooling 已从 workspace 删除。你可以先把它理解成：

```text
agent = LLM + harness
```

这里的 LLM 当前走 DeepSeek。LLM 本身不是这个仓库要实现的东西；这个仓库真正值得读、值得讲、也适合作为实习项目经验的部分，是 harness。

Harness 负责把用户输入接进来，组织上下文，决定模型能调用哪些工具，执行文件和 shell 操作，记录 session、memory 和 approval，再把结果流式返回给 UI。

## 产品边界

当前 Kodeks 只保留 coding agent 闭环里最核心的能力：

- 在一个本地 project workspace 上进行流式对话。
- 保存多 session transcript，并支持继续历史会话。
- 提供 workspace tools：读文件、写文件、grep、执行 shell。
- 对危险 shell 命令记录 approval。
- 提供 memory 写入、召回和 artifact 读取。
- 支持 plan mode，并在 plan mode 下过滤会修改 workspace 的工具。
- 支持 subagent exploration，并保存可审计 summary。
- 支持 MCP server 和 skill discovery。
- 支持通过 MoonBridge 路由 DeepSeek Chat Completions。

不在这条主线上的东西都应该谨慎加入。Web search、重复的 stream 协议、provider dashboard、高级 memory ranking、大型 plugin surface 都先延后，直到这条核心闭环足够小、足够可靠。

## 主请求链路

默认 chat 请求的主路径是：

1. 浏览器打开 FastAPI 服务的 `/` Python-hosted UI。
2. 浏览器把用户输入 POST 到 Python `/api/chat/stream`。
3. `src/kodeks/app.py` 的 FastAPI route 接收请求并打开同一 SSE stream contract。
4. `src/kodeks/runtime.py` 创建 runtime context，包括 workspace、model options、storage repositories、memory、plan artifact 和 tool services。
5. `src/kodeks/providers/bridge.py` 把 Responses-shaped 请求转换成 DeepSeek Chat Completions。
6. `src/kodeks/tools/`、`src/kodeks/workspace.py`、`src/kodeks/storage/` 执行工具、workspace policy、approval 和 transcript 写入。
7. UI 直接渲染 Kodeks SSE events。

可以把链路记成：

```text
UI
 -> FastAPI /api/chat/stream
 -> run_python_chat_turn()
 -> MoonBridge
 -> model text/tool_call
 -> Python ToolRegistry.execute()
 -> Python WorkspaceService / Storage
 -> tool_result
 -> model continues
 -> SSE event back to UI
```

本地启动方式：

1. 运行 `uv run kodeks-server --reload`。
2. 打开 `http://127.0.0.1:8000`。

旧 TypeScript SDK runtime、Next.js shell 和 pnpm workspace 已从 Web chat route 运行路径和 workspace 中移除。默认 chat route 不再自动或显式回到 TypeScript OpenAI SDK。

## 推荐阅读顺序

不要从旧 TypeScript backend 的提交历史开始读。当前 runtime 已迁到 Python，先按下面的路径理解现有系统。

更好的顺序是：

1. `docs/architecture.md`：先建立全局地图。
2. `docs/MODERNIZATION.md`：如果在做 Python 迁移，先看迁移面和 checkpoint 合同。
3. `src/kodeks/app.py`：看 Python runtime 接管的 HTTP route 和默认 UI。
4. `src/kodeks/static/index.html`：看 Python-hosted browser shell。
5. `src/kodeks/runtime.py`：看一轮 chat turn 如何准备 session、memory、tools 和 SSE events。
6. `src/kodeks/providers/bridge.py`：看 DeepSeek Chat Completions 如何适配 Responses-shaped stream。
7. `src/kodeks/contracts.py`：看 Python Pydantic 模型如何冻结旧 TypeScript wire shape。
8. `src/kodeks/tools/`、`src/kodeks/workspace.py`、`src/kodeks/storage/`：看工具、安全边界和持久化。

## 模型边界

前端和用户真正需要理解的 provider surface 已经收缩为一类：

- `moonbridge`：本地 Responses-compatible bridge，用来接 DeepSeek Chat Completions endpoint。

MoonBridge 的意义是让 Kodeks 内部继续使用一套 Responses-shaped event contract，同时兼容 DeepSeek Chat Completions endpoint。

`src/kodeks/config.py` 应该保持小。它只负责解析 DeepSeek 配置、创建 MoonBridge client options，不应该再拥有多 provider 产品概念。Python runtime 对外只保留 `deepseek/deepseek-v4-pro` 这个模型 ref，MoonBridge 是内部适配层。

## Memory 边界

Memory 可以参考 TencentDB-Agent-Memory 的分层想法，但当前实现故意保持 MVP：

- L0：runtime 已经保存的 transcript 和 tool evidence。
- L1：用户偏好、项目事实、稳定经验等 atomic facts。
- L2：重复 workflow 或 debugging pattern 的 scenario memories。
- L3：从低层 memory 汇总出来的 profile 和 project-level summaries。
- Artifacts：较大的证据内容只存引用 id，避免每次 prompt 都塞大段内容。

Embedding、vector rerank、freshness scoring、dashboard、完整 graph structure、自动大规模 consolidation 都是后续能力，不是理解当前 coding-agent loop 的前置条件。

## 调试入口

日常开发命令：

```bash
uv run kodeks-server --reload
uv run pytest
uv run ruff check
uv run mypy
uv run python -m kodeks.smoke --in-process
```

如果只想调 MoonBridge：

```bash
uv run pytest tests/test_bridge.py tests/test_route_parity.py
uv run kodeks-server --reload
```

如果只想调 Python compatibility runtime：

```bash
uv run pytest
uv run ruff check
uv run mypy
uv run kodeks-server --reload
```

## 当前刻意删除或延后的东西

为了让项目更适合学习和讲述，当前简化掉了：

- web search tools 和相关 settings。
- Brave/Tavily 环境配置。
- `/api/chat/ui-stream` 这类重复 stream runtime。
- runtime 对 Vercel AI SDK UIMessage helpers 的直接依赖。
- 用户可见的 `bridge` provider naming。

剩下的系统可以概括成：一个 web app、一个 runtime event contract、一个 tool registry、一个 storage boundary、两个模型接入选项。
