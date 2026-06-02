# kodeks

**kodeks** 是一个 local-first coding agent workbench，用来实验现代软件工程 agent 的核心闭环：流式对话、workspace tools、shell approval、memory、session、plan mode 和 subagent exploration。

[English README](./README.md) · [产品需求](./docs/PRD.md) · [概念映射](./docs/concepts-map.md) · [现代化计划](./docs/MODERNIZATION.md) · [历史 TS 设计](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## 当前状态

kodeks 已经完成从 TypeScript OpenAI/Agents SDK workspace 到 Python OpenAI SDK runtime 的 active migration。当前实现是 MVP，不是托管型产品。它的目标是保持足够小，方便学习和扩展，同时保留真实 coding agent 需要的关键边界。

Chat 现在要求 Python/FastAPI runtime。旧 TypeScript OpenAI/Agents SDK runtime、Next.js API routes、pnpm workspace 和 TypeScript web shell 都已从 active repository 移除。Python 负责 UI 入口、API routes、chat runtime、model routing、storage、workspace tools、approvals 和 bridge compatibility layers。

## 功能亮点

- FastAPI 服务的 Python-hosted 浏览器 UI。
- 基于 Server-Sent Events 的流式对话。
- DeepSeek-only chat 模型路由，通过 MoonBridge 接入。
- 内置 MoonBridge，可把 DeepSeek Chat Completions 暴露成本地 Responses API。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs 和 audit logs。
- plan mode 下只暴露 read-only tools。

## 快速开始

```bash
uv sync
uv run kodeks-server --reload
```

打开 `http://127.0.0.1:8000`。

安装后的 package 会暴露同一个 server entrypoint：`kodeks-server`。

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

- 一个 DeepSeek Chat Completions API key，通过 MoonBridge 接入。

Kodeks 不再要求把 secret 写进 repo 里的 `.env`。本地产品化使用时，可以把模型配置放到 workspace 外的用户配置文件：

- 默认：`~/.kodeks/config.json`
- 用 `KODEKS_CONFIG_DIR` 覆盖配置目录
- 用 `KODEKS_CONFIG_PATH` 覆盖精确配置文件

如果新的 `~/.kodeks/config.json` 不存在，Kodeks 仍会兼容读取早期平台目录里的配置文件。

DeepSeek 是唯一支持的 chat provider。配置标准 Chat Completions 键后，Kodeks
会通过本地 MoonBridge adapter 路由请求。

```json
{
  "model": {
    "provider": "moonbridge",
    "chatCompletions": {
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-v4-pro"
    }
  }
}
```

DeepSeek 默认值：

- `KODEKS_CHAT_COMPLETIONS_BASE_URL` 默认是 `https://api.deepseek.com`
- `KODEKS_CHAT_COMPLETIONS_MODEL` 默认是 `deepseek-v4-pro`
- `KODEKS_MODEL_PROVIDER=moonbridge` 会强制走 DeepSeek/MoonBridge

DeepSeek V4 的 thinking mode 默认会通过 MoonBridge 启用，除非设置
`KODEKS_BRIDGE_REASONING_EFFORT=none`。当模型调用工具时，MoonBridge 会在
assistant tool-call 消息上保留 DeepSeek 返回的 `reasoning_content`，让后续
Chat Completions 请求保持 DeepSeek API 要求的上下文形态。

环境变量仍可用于开发和部署 secret。显式环境变量会覆盖用户配置文件。

为了兼容旧配置，仍会读取 provider registry，但 chat 路由只使用 `deepseek`
entry：

```json
{
  "model": {
    "primary": "deepseek/deepseek-v4-pro",
    "providers": {
      "deepseek": {
        "api": "chat-completions",
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-...",
        "models": [{ "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }]
      }
    }
  },
  "embeddings": {
    "enabled": true,
    "provider": "local"
  }
}
```

Memory embedding rerank 是可选能力。启用后默认使用无需下载模型的本地 hash
embedding，并把向量缓存在 SQLite；如果需要更强语义能力，可以显式切到 Ollama 或
Hugging Face-compatible feature extraction：

```bash
KODEKS_EMBEDDINGS_ENABLED=true
KODEKS_EMBEDDINGS_PROVIDER=local

# 可选：本地 Ollama
KODEKS_EMBEDDINGS_PROVIDER=ollama
KODEKS_OLLAMA_BASE_URL=http://127.0.0.1:11434
KODEKS_OLLAMA_EMBED_MODEL=embeddinggemma

# 可选：LM Studio / OpenAI-compatible embeddings endpoint
KODEKS_EMBEDDINGS_PROVIDER=lmstudio
KODEKS_OPENAI_COMPAT_BASE_URL=http://127.0.0.1:1234/v1
KODEKS_OPENAI_COMPAT_EMBED_MODEL=embedding-model

# 可选：Hugging Face-compatible endpoint
KODEKS_EMBEDDINGS_PROVIDER=huggingface
KODEKS_HUGGINGFACE_EMBED_MODEL=ibm-granite/granite-embedding-97m-multilingual-r2
KODEKS_HUGGINGFACE_API_TOKEN=hf_...
```

可选：

- `KODEKS_MODEL_PROVIDER=moonbridge` 选择 DeepSeek/MoonBridge 路径；直连 `openai` / `responses` chat provider 已移除
- `KODEKS_CHAT_COMPLETIONS_API_KEY`、`KODEKS_CHAT_COMPLETIONS_BASE_URL`、`KODEKS_CHAT_COMPLETIONS_MODEL` 用于配置 MoonBridge 的上游 Chat Completions endpoint
- `KODEKS_BRIDGE_ENABLED=true` 会启用内置 bridge Responses 路径
- `KODEKS_BRIDGE_BASE_URL` 是本地 MoonBridge 的 Responses URL，默认是 `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL` 是本地 MoonBridge 的模型 alias，默认是 `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_STRICT_TOOL_SCHEMAS=true` 让 Responses/Agents function tools 经过本地 schema 归一化后启用 strict；默认仍是 `strict: false`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

已移除 alias 迁移表：

- `DEEPSEEK_API_KEY` -> `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `DEEPSEEK_BASE_URL` -> `KODEKS_CHAT_COMPLETIONS_BASE_URL`
- `DEEPSEEK_MODEL` -> `KODEKS_CHAT_COMPLETIONS_MODEL`
- `KODEKS_BRIDGE_DEEPSEEK_*` -> `KODEKS_CHAT_COMPLETIONS_*`
- `MOONBRIDGE_API_KEY`、`MOONBRIDGE_BASE_URL`、`MOONBRIDGE_MODEL`、`MOONBRIDGE_ENABLED`、`MOONBRIDGE_REASONING_EFFORT` -> 对应的 `KODEKS_BRIDGE_*`
- provider override `bridge`、`deepseek`、`chat-completions` -> `moonbridge`

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。

`/api/chat/stream` 仍是稳定的 Kodeks SSE runtime path。`/api/chat/ui` 是实验 adapter route，会把同一批 runtime events 映射成 UI transport 风格的 SSE payload，不改变 provider 执行路径。

### MoonBridge for Chat Completions

MoonBridge 的存在意义是服务那些只暴露 Chat Completions、没有 Responses API 的 OpenAI-compatible endpoint。Python runtime 暴露 Responses 形态的 bridge routes，并把请求转换成上游 `/chat/completions`。

这样启动 Python runtime：

```bash
KODEKS_CHAT_COMPLETIONS_API_KEY=sk-... \
KODEKS_CHAT_COMPLETIONS_BASE_URL=https://api.deepseek.com \
KODEKS_CHAT_COMPLETIONS_MODEL=deepseek-v4-pro \
uv run kodeks-server --reload
```

Python service 会在 `/v1/responses` 暴露 bridge endpoint。设置同样的 `KODEKS_CHAT_COMPLETIONS_*` 并在 UI 里选择 `moonbridge` 即可使用它。

Bridge health 和 smoke check 指向 Python service：

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"moonbridge","input":"hello","stream":false}'
```

旧的 TypeScript `moonbridge:*` 和 `bridge:*` 脚本 alias 已随 TypeScript SDK backend packages 一起移除。

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

第一条不会打开本地 socket。安装后的 package 会暴露同一个 smoke entrypoint：`kodeks-smoke`。默认 smoke 会覆盖 health、模型清单、无副作用 `/api/chat/stream` validation 和 bridge preflight。最后一条会调用 `/v1/responses`，需要已经配置 provider secret。

Agent evals：

```bash
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py
UV_CACHE_DIR=.uv-cache uv run python evals/run_local.py --live-provider
```

eval suite 会用 deterministic model / Agents SDK fake 调用真实 FastAPI route，然后按 OpenAI concept 给 event trace 打分：tools、approval、context management、memory、planning、model routing 和 UI transport。可选的 `--live-provider` lane 会使用已配置的真实 provider，并在结果 JSON 里记录 latency。运行结果写入 `evals/results/latest.json`，该文件不会进入 Git。

TypeScript OpenAI/Agents SDK backend packages、Next.js shell 和 pnpm workspace 已删除。当前 Python runtime 覆盖 health、模型清单、sessions、workspace 文件列表、approvals、MoonBridge 协议 adapter、可确定性测试的 chat loop、同一轮 tool continuation、本地工具执行、approval-required events、UI transport 映射、static UI serving，以及通过 DeepSeek/MoonBridge 的 route-level chat streaming。

- `src/kodeks`: Python runtime、FastAPI routes、Pydantic contracts、SQLite repositories、模型配置、MoonBridge adapter、tools、workspace policy 和 SSE helpers。

## 安全模型

kodeks 把本地能力视为高权限能力：

- 文件访问必须经过 workspace policy。
- `.git`、`.kodeks`、依赖目录和虚拟环境等内部路径会被阻止。
- 危险 shell 命令不会立刻执行，而是生成 approval record。
- approval decision 可审计，并且只能消费一次。

这是一个本地开发项目。对敏感仓库使用前，请先审查 policy 和 storage 相关代码。

## 文档

- [`docs/PRD.md`](./docs/PRD.md): 产品目标、能力路线和验收标准。
- [`docs/concepts-map.md`](./docs/concepts-map.md): OpenAI concept 到 Kodeks 代码资产和 eval coverage 的映射。
- [`docs/MODERNIZATION.md`](./docs/MODERNIZATION.md): 模型 provider 迁移、依赖状态、验证和回退计划。
- [`docs/superpowers/`](./docs/superpowers/): 需要跨机器同步的设计 specs。

生成型 notes、scratch docs、本地数据库和编辑器状态会被排除在版本控制之外。

## License

[MIT](./LICENSE)
