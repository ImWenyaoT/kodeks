# Kodeks 架构说明

Kodeks 是一个 local-first 的 coding agent workbench。用户界面、HTTP API、chat runtime 和本地工具执行都由 Python/FastAPI 服务承载。你可以先把它理解成：

```text
agent = LLM + harness
```

这里的 LLM 当前走 DeepSeek。LLM 本身不是这个仓库要实现的东西；这个仓库真正值得读、值得讲、也适合作为实习项目经验的部分，是 harness。

Harness 负责把用户输入接进来，组织上下文，决定模型能调用哪些工具，执行文件和 shell 操作，记录 session、memory 和 approval，再把结果流式返回给 UI。

## 产品边界

Kodeks 的产品边界是带 memory、multi-session、subagent 和 plan mode 的 coding agent。核心能力是：

- 在一个本地 project workspace 上进行流式对话。
- 保存多 session transcript，并支持继续历史会话。
- 提供 workspace tools：读文件、写文件、grep、执行 shell。
- 对危险 shell 命令记录 approval。
- 提供 memory 写入、召回和 artifact 读取。
- 支持 plan mode，并在 plan mode 下过滤会修改 workspace 的工具。
- 支持受控 subagent exploration，并保存 parent session、read-only tool surface 和可审计 summary。
- 按固定小集合选择 harness pattern：`single_turn`、`fanout_synthesize`、`adversarial_verify`、`loop_until_done` 或 `tournament`。
- 支持通过 MoonBridge 路由 DeepSeek Chat Completions。
- 支持 MCP server manifest discovery，作为协议集成入口。

Web search、重复的 stream 协议、provider dashboard 和大型 plugin surface 不属于 Kodeks 的产品范围。项目应该把 memory、multi-session、subagent、plan mode、workspace tools、approval 和协议适配这些主线能力做深，而不是扩成泛用 agent 平台。

## 主请求链路

默认 chat 请求的主路径是：

1. 浏览器打开 FastAPI 服务的 `/` Python-hosted UI。
2. 浏览器把用户输入 POST 到 Python `/api/chat/stream`。
3. `src/kodeks/app.py` 的 FastAPI route 接收请求并打开同一 SSE stream contract。
4. `src/kodeks/runtime.py` 创建 runtime context，包括 workspace、model options、storage repositories、memory、plan artifact、harness pattern 和 tool services。
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

## 推荐阅读顺序

建议按下面的顺序理解现有系统：

1. `docs/architecture.md`：先建立全局地图。
2. `src/kodeks/app.py`：看 HTTP route、FastAPI app assembly 和默认 UI。
3. `src/kodeks/static/index.html`：看 browser shell。
4. `src/kodeks/runtime.py`：看一轮 chat turn 如何准备 session、memory、tools 和 SSE events。
5. `src/kodeks/harness.py`：看固定 harness pattern 如何对抗半途而废、自证偏见和目标漂移。
6. `src/kodeks/responses_runtime.py`：看 Responses-shaped event stream 和工具续跑循环。
7. `src/kodeks/providers/bridge.py`：看 DeepSeek Chat Completions 如何适配 Responses-shaped stream。
8. `src/kodeks/contracts.py`：看 Pydantic wire contracts。
9. `src/kodeks/tools/`、`src/kodeks/workspace.py`、`src/kodeks/storage/`：看工具、安全边界和持久化。

## 模型边界

前端和用户真正需要理解的 provider surface 是一类：

- `moonbridge`：本地 Responses-compatible bridge，用来接 DeepSeek Chat Completions endpoint。

MoonBridge 的意义是让 Kodeks 内部继续使用一套 Responses-shaped event contract，同时兼容 DeepSeek Chat Completions endpoint。

`src/kodeks/config.py` 保持小，只负责定位并读取用户配置；`src/kodeks/model_config.py` 负责解释 DeepSeek 配置、创建 MoonBridge client options。Python runtime 对外提供 `deepseek/deepseek-v4-pro` 这个模型 ref，MoonBridge 是内部适配层。

## Memory 边界

Memory 围绕 coding agent 的长期可用上下文设计：

- L0：runtime 持久化的 transcript 和 tool evidence。
- Facts：用户偏好、项目事实、稳定经验等 atomic facts。
- Artifacts：较大的工具证据只存引用 id，避免每次 prompt 都塞大段内容。

Memory 的目标不是做独立知识库产品，而是让 coding agent 在多 session、plan mode、subagent exploration 和 workspace tool evidence 之间保持连续、可审计、可压缩的上下文。

## Runtime 纪律

Kodeks 借鉴 AX 的 design taste，但不引入分布式 agent runtime。这里采用的是小版本：

- 一个 runtime controller 负责每轮 turn 的状态推进。
- harness pattern 是固定小集合，不接受任意 workflow 脚本。
- tool call、tool result、approval、plan checkpoint、subagent run 都写入 audit log。
- session resume 是继续同一个 session；session fork 是创建带 `parentSessionId` 的新 session。
- subagent 是 parent session 下的 read-only child run，并用 claim/evidence/risk/confidence/nextAction 合同回传，不是独立 agent 平台。

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

如果只想调 Python runtime：

```bash
uv run pytest
uv run ruff check
uv run mypy
uv run kodeks-server --reload
```

## 非目标

下面这些不属于 Kodeks 的产品范围：

- web search tools 和相关 settings。
- Brave/Tavily 环境配置。
- 重复的 stream runtime。
- provider dashboard。
- 大型 plugin marketplace。
- 用户可见的 `bridge` provider naming。

系统可以概括成：一个 web app、一个 runtime event contract、一个 tool registry、一个 storage boundary、一个 approval boundary、一套 memory/subagent/plan-mode 状态模型，一个固定 harness pattern selector，以及一个 DeepSeek/MoonBridge 协议适配层。
