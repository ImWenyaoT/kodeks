# kodeks

**kodeks** 是一个 local-first 的 TypeScript coding agent runtime，用来实验现代软件工程 agent 的核心闭环：流式对话、workspace tools、shell approval、memory、session、plan mode 和 subagent exploration。

[English README](./README.md) · [产品需求](./docs/PRD.md) · [迁移设计](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## 当前状态

kodeks 已经从 Python/FastAPI 原型迁移到 TypeScript workspace。当前实现是 MVP，不是托管型产品。它的目标是保持足够小，方便学习和扩展，同时保留真实 coding agent 需要的关键边界。

旧 Python 实现已经从当前仓库移除；TypeScript workspace 是唯一维护中的 runtime。

## 功能亮点

- Next.js App Router Web 应用和 API routes。
- 基于 Server-Sent Events 的流式对话。
- OpenAI Agents SDK 作为主 agent runtime，并优先走 Responses API。
- 支持直连 Responses-compatible endpoint。
- 内置 MoonBridge，可把 Chat Completions-compatible endpoint 暴露成本地 Responses API。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs 和 audit logs。
- plan mode 下只暴露 read-only tools。

## 快速开始

```bash
pnpm install
pnpm run dev
```

打开 `http://127.0.0.1:3000`。

Next.js 在 3000 空闲时默认使用 3000 端口。日常本地开发建议显式指定端口，
这样其它项目占用 3000 时也不会影响 kodeks 的访问地址：

```bash
PORT=3001 pnpm run dev
APP_URL=http://127.0.0.1:3001
```

Windows PowerShell 下：

```powershell
$env:PORT=3001; pnpm run dev
$env:APP_URL="http://127.0.0.1:3001"
```

如果没有设置 `PORT`，请以 Next.js 终端输出的实际 URL 为准。多个本地 Web
项目同时运行时，不要默认认为 `localhost:3000` 一定是 kodeks。

健康检查：

```bash
curl "$APP_URL/api/sessions"
```

SSE chat stream：

```bash
curl -N -X POST "$APP_URL/api/chat/stream" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## 配置

必需：

- 一个 Responses-compatible endpoint，或一个通过 MoonBridge 转接的 Chat Completions-compatible endpoint。

Kodeks 不再要求把 secret 写进 repo 里的 `.env`。本地产品化使用时，可以把模型配置放到 workspace 外的用户配置文件：

- 默认：`~/.kodeks/config.json`
- 用 `KODEKS_CONFIG_DIR` 覆盖配置目录
- 用 `KODEKS_CONFIG_PATH` 覆盖精确配置文件

如果新的 `~/.kodeks/config.json` 不存在，Kodeks 仍会兼容读取早期平台目录里的配置文件。

```json
{
  "model": {
    "provider": "responses",
    "responses": {
      "apiKey": "sk-...",
      "baseURL": "https://api.openai.com/v1",
      "model": "gpt-5.4-mini"
    }
  }
}
```

如果某个 OpenAI-compatible 服务已经实现 Responses API，选择 `provider: "responses"`，Kodeks 会直接调用它。如果服务只实现 Chat Completions，比如很多 DeepSeek 或 Qwen 部署，选择 MoonBridge，并配置上游 Chat Completions endpoint：

```json
{
  "model": {
    "provider": "moonbridge",
    "chatCompletions": {
      "apiKey": "sk-or-local-placeholder",
      "baseURL": "https://chat-compatible.example/v1",
      "model": "qwen-coder"
    }
  }
}
```

环境变量仍可用于开发和部署 secret。显式环境变量会覆盖用户配置文件。

也支持类似 OpenClaw 的 provider registry。`api: "responses"` 表示直连 Responses-compatible endpoint；`api: "chat-completions"` 表示通过 MoonBridge 接入 Chat Completions endpoint：

```json
{
  "model": {
    "primary": "qwen/qwen3.6",
    "providers": {
      "qwen": {
        "api": "chat-completions",
        "baseURL": "http://172.18.45.70:8010/v1",
        "apiKey": "local-placeholder",
        "models": [{ "id": "qwen3.6", "name": "Qwen 3.6" }]
      }
    }
  },
  "embeddings": {
    "enabled": true,
    "provider": "openai-compatible",
    "baseURL": "http://172.18.45.70:8011/v1",
    "apiKey": "local-placeholder",
    "model": "qwen3-embedding-4b"
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
KODEKS_LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
KODEKS_LMSTUDIO_EMBED_MODEL=Qwen/Qwen3-Embedding-0.6B

# 可选：Hugging Face-compatible endpoint
KODEKS_EMBEDDINGS_PROVIDER=huggingface
KODEKS_HUGGINGFACE_EMBED_MODEL=ibm-granite/granite-embedding-97m-multilingual-r2
KODEKS_HUGGINGFACE_API_TOKEN=hf_...
```

可选：

- `KODEKS_MODEL_PROVIDER` 可选 `responses`、`openai`、`bridge` 或 `moonbridge`；旧的 `deepseek` 会被当作 MoonBridge alias
- `KODEKS_RESPONSES_API_KEY`、`KODEKS_RESPONSES_BASE_URL`、`KODEKS_RESPONSES_MODEL` 用于配置直连 Responses-compatible endpoint；`OPENAI_*` 仍作为官方 OpenAI alias 保留
- `KODEKS_CHAT_COMPLETIONS_API_KEY`、`KODEKS_CHAT_COMPLETIONS_BASE_URL`、`KODEKS_CHAT_COMPLETIONS_MODEL` 用于配置 MoonBridge 的上游 Chat Completions endpoint
- `KODEKS_BRIDGE_ENABLED=true` 会启用内置 bridge Responses 路径
- `KODEKS_BRIDGE_BASE_URL` 是本地 MoonBridge 的 Responses URL，默认是 `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL` 是本地 MoonBridge 的模型 alias，默认是 `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `MOONBRIDGE_*`、`KODEKS_BRIDGE_DEEPSEEK_*` 和 `DEEPSEEK_*` 环境变量名仍作为 Chat Completions 上游兼容 alias 被接受
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`，默认是 `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT`，默认是 `medium`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。

### MoonBridge for Chat Completions

MoonBridge 的存在意义是服务那些只暴露 Chat Completions、没有 Responses API 的 OpenAI-compatible endpoint。Kodeks 自己仍然发送 Responses 形态的请求到 `http://127.0.0.1:38440/v1/responses`，MoonBridge 再把请求转换成上游 `/chat/completions`。

先启动内置 TypeScript bridge，再这样启动 Kodeks：

```bash
KODEKS_CHAT_COMPLETIONS_API_KEY=$DEEPSEEK_API_KEY \
KODEKS_CHAT_COMPLETIONS_BASE_URL=https://api.deepseek.com \
KODEKS_CHAT_COMPLETIONS_MODEL=deepseek-v4-pro \
pnpm run bridge:start

KODEKS_MODEL_PROVIDER=moonbridge pnpm run dev
```

如果由 Next.js runtime 托管 bridge，设置同样的 `KODEKS_CHAT_COMPLETIONS_*` 并在 UI 里选择 `moonbridge` 即可；runtime 会在需要时启动本地 bridge。

Bridge helper 命令：

```bash
pnpm run bridge:start
pnpm run bridge:health
pnpm run bridge:smoke
```

旧的 `moonbridge:start`、`moonbridge:health`、`moonbridge:smoke` 脚本仍保留为内置 bridge 的兼容 alias。

## 开发

```bash
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run start
```

仓库使用 pnpm workspaces：

- `apps/web`: UI、API routes 和 stream adapters。
- `packages/agent-runtime`: OpenAI Agents SDK turn orchestration、context assembly、plan mode 和本地 tool wrappers。
- `packages/model`: provider 配置和直连 Responses-compatible model calls。
- `packages/responses-bridge`: 内置 Responses-to-Chat-Completions bridge 和协议 adapter。
- `packages/tools`: model-callable tool registry 和 policy wrappers。
- `packages/workspace`: workspace path policy、file access 和 shell execution。
- `packages/storage`: SQLite repositories。
- `packages/shared`: shared IDs、errors、results 和 JSON helpers。

## 安全模型

kodeks 把本地能力视为高权限能力：

- 文件访问必须经过 workspace policy。
- `.git`、`.kodeks`、依赖目录和虚拟环境等内部路径会被阻止。
- 危险 shell 命令不会立刻执行，而是生成 approval record。
- approval decision 可审计，并且只能消费一次。

这是一个本地开发项目。对敏感仓库使用前，请先审查 policy 和 storage 相关代码。

## 文档

- [`docs/PRD.md`](./docs/PRD.md): 产品目标、能力路线和验收标准。
- [`docs/superpowers/`](./docs/superpowers/): 需要跨机器同步的设计 specs。
- [`AGENTS.md`](./AGENTS.md): 本地 agent 协作说明。

生成型 notes、scratch docs、本地数据库和编辑器状态会被排除在版本控制之外。

## License

[MIT](./LICENSE)
