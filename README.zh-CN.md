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
- 内置 TypeScript Responses bridge，可把 DeepSeek 接回 OpenAI-compatible Responses API 形态。
- DeepSeek Chat Completions adapter 保留为非 Responses fallback，支持 Thinking Mode 和 function tool streaming。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs 和 audit logs。
- plan mode 下只暴露 read-only tools。
- 面向 SDK-native 客户端的 Vercel AI SDK UIMessage stream adapter。

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

Vercel AI SDK UIMessage stream：

```bash
curl -N -X POST "$APP_URL/api/chat/ui-stream" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## 配置

必需：

- 默认路径设置 `OPENAI_API_KEY`，走 OpenAI Agents SDK + Responses；使用本地 bridge 时可设置 `KODEKS_MODEL_PROVIDER=bridge`；直连 DeepSeek Chat Completions fallback 需要 `DEEPSEEK_API_KEY`。

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

- `KODEKS_MODEL_PROVIDER` 可选 `bridge`、`moonbridge`、`deepseek` 或 `openai`
- `KODEKS_BRIDGE_ENABLED=true` 会启用内置 bridge Responses 路径
- `KODEKS_BRIDGE_BASE_URL`，默认是 `http://127.0.0.1:38440/v1`
- `KODEKS_BRIDGE_MODEL`，默认是 `bridge`
- `KODEKS_BRIDGE_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `MOONBRIDGE_*` 环境变量名仍作为兼容 alias 被接受
- `DEEPSEEK_BASE_URL`，默认是 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`，默认是 `deepseek-v4-pro`
- `DEEPSEEK_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`，默认是 `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT`，默认是 `medium`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。

### Built-in Bridge + DeepSeek Responses

先启动内置 TypeScript bridge，让它暴露 `http://127.0.0.1:38440/v1/responses`，再这样启动 Kodeks：

```bash
KODEKS_BRIDGE_DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY pnpm run bridge:start
KODEKS_MODEL_PROVIDER=bridge pnpm run dev
```

这个模式下，Kodeks 会发送 Responses API 形态的请求到本地 bridge，再由 bridge 通过 Chat Completions 路由到 DeepSeek V4。

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
- `packages/model`: DeepSeek Chat Completions 与直连 Responses-compatible model calls 的 fallback provider adapters。
- `packages/responses-bridge`: 内置 Responses-to-DeepSeek bridge 和协议 adapter。
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
