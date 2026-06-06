# kodeks

**kodeks** 是一个 local-first coding agent workbench。它的范围刻意保持很小：
一个带 memory、multi-session、subagent exploration、plan mode、workspace tools、
人工审批，以及 OpenAI-compatible Chat Completions 协议适配的 coding agent。
DeepSeek 是默认 upstream。

[English README](./README.md) · [架构说明](./docs/architecture.md) · [产品需求](./docs/PRD.md) · [概念映射](./docs/concepts-map.md)

## 产品边界

Kodeks 不是泛用 agent 平台，不做 web search、provider dashboard、plugin
marketplace 或托管型 agent surface。这个 codebase 的重点是用尽量小的实现讲清楚
LLM harness：

- 状态管理：sessions、transcript replay、plans、memory、artifacts、approvals 和
  subagent run records。
- 流程控制：streaming turn、tool call、tool-result continuation、plan-mode
  read-only filtering 和 terminal errors。
- 人工审批：危险 shell execution 需要 durable decision 和 audit event。
- 可观测性：SSE runtime events、smoke checks、eval traces 和 audit logs。
- 多 Agent：read-only subagent exploration 和可持久化 summary。
- 协议集成：Responses-shaped runtime contract，以及 MoonBridge 到
  OpenAI-compatible Chat Completions 的转换。

设计中心是 harness 理解：上下文组装、工具、权限、状态、协议形态和评测。

## 功能亮点

- FastAPI 服务的浏览器 UI。
- 基于 Server-Sent Events 的流式对话。
- DeepSeek 通过 MoonBridge 的 OpenAI-compatible Chat Completions adapter 路由。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs、
  plan artifacts 和 audit logs。
- plan mode 下只暴露 read-only tools。
- 针对 tools、approval、memory、planning、model routing 和 UI transport 的本地确定性 eval。

## 快速开始

```bash
uv sync
uv run kodeks-server --reload
```

打开 `http://127.0.0.1:8000`。

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

SSE chat stream：

```bash
curl -N -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## 配置

必需：

- 一个 OpenAI-compatible Chat Completions API key，通过 MoonBridge 接入。
  DeepSeek 是默认 upstream。

本地开发最简单的方式是项目根目录 `.env`：

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

结构化模型配置也可以放到项目本地配置或用户级配置里：

- 项目本地：`.kodeks/config.json`
- 用户级 fallback：`~/.kodeks/config.json`
- 用 `KODEKS_CONFIG_DIR` 覆盖配置目录
- 用 `KODEKS_CONFIG_PATH` 覆盖精确配置文件

```json
{
  "model": {
    "chatCompletions": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-pro"
    }
  }
}
```

配置优先级是：

1. 显式进程环境变量
2. 项目 `.env`
3. 结构化配置文件

除非设置了 `KODEKS_CONFIG_DIR` 或 `KODEKS_CONFIG_PATH`，项目本地配置会先于
用户级 fallback 被读取。

常用选项：

- `API_KEY` 或 `DEEPSEEK_API_KEY`
- `BASE_URL` 或 `DEEPSEEK_BASE_URL`，默认是 `https://api.deepseek.com`
- `MODEL` 或 `DEEPSEEK_MODEL`，默认是 `deepseek-v4-pro`；内置 DeepSeek catalog
  包含 `deepseek-v4-pro` 和 `deepseek-v4-flash`
- `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `KODEKS_CHAT_COMPLETIONS_BASE_URL`
- `KODEKS_CHAT_COMPLETIONS_MODEL`
- `KODEKS_BRIDGE_ENABLED=true`
- `KODEKS_BRIDGE_BASE_URL`，默认是 `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL`，默认是 `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT`，支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_STRICT_TOOL_SCHEMAS=true`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

DeepSeek thinking mode 默认会通过 MoonBridge 启用，除非设置
`KODEKS_BRIDGE_REASONING_EFFORT=none`。当模型调用工具时，MoonBridge 会在
assistant tool-call 消息上保留 DeepSeek 的 `reasoning_content`，让后续 Chat
Completions 请求保持所需上下文形态。

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。本地 `.env` 也不会进入
Git。需要结构化配置时，项目本地模型配置可以放在 `.kodeks/config.json`。

## MoonBridge

MoonBridge 是内部协议适配层。Kodeks 保持 Responses-shaped runtime contract，
同时把 OpenAI-compatible Chat Completions 作为 upstream。DeepSeek 是默认 upstream。

这样启动 runtime：

```bash
DEEPSEEK_API_KEY=sk-... \
DEEPSEEK_BASE_URL=https://api.deepseek.com \
DEEPSEEK_MODEL=deepseek-v4-pro \
uv run kodeks-server --reload
```

Bridge routes 由同一个 FastAPI process 提供：

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonbridge","input":"hello","stream":false}'
```

## 开发

```bash
uv run pytest
uv run ruff check
uv run mypy
uv build
```

Runtime smoke checks：

```bash
uv run python -m kodeks.smoke --in-process
uv run kodeks-server --reload
uv run python -m kodeks.smoke --base-url http://127.0.0.1:8000
uv run python -m kodeks.smoke --live-provider --model moonbridge
```

默认 smoke 覆盖 health、模型清单、无副作用 `/api/chat/stream` validation 和 bridge
preflight。live-provider lane 需要已经配置 provider secret。

Agent evals：

```bash
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py --live-provider
```

eval suite 会调用用户实际使用的 FastAPI routes，并用 deterministic model fakes 对
event trace 打分。评分维度是 harness 六项：状态管理、流程控制、人工审批、可观测性、
多 Agent 和协议集成。结果写入 `evals/results/latest.json`，该文件不会进入 Git。

## 安全模型

kodeks 把本地能力视为高权限能力：

- 文件访问必须经过 workspace policy。
- `.git`、`.kodeks`、依赖目录和虚拟环境等内部路径会被阻止。
- 危险 shell 命令不会立刻执行，而是生成 approval record。
- approval decision 可审计，并且只能消费一次。

这是一个本地开发项目。对敏感仓库使用前，请先审查 policy 和 storage 相关代码。

## 文档

- [`docs/architecture.md`](./docs/architecture.md): 当前 runtime 架构和产品边界。
- [`docs/PRD.md`](./docs/PRD.md): 产品目标、harness 评判标准和验收检查。
- [`docs/concepts-map.md`](./docs/concepts-map.md): harness 维度到代码资产和 eval coverage 的映射。

生成型 notes、scratch docs、本地数据库和编辑器状态会被排除在版本控制之外。

## License

[MIT](./LICENSE)
