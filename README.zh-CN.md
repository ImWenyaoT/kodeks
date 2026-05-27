# kodeks

**kodeks** 是一个 local-first 的 TypeScript coding agent runtime，用来实验现代软件工程 agent 的核心闭环：流式对话、workspace tools、shell approval、memory、session、plan mode 和 subagent exploration。

[English README](./README.md) · [产品需求](./docs/PRD.md) · [迁移设计](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## 当前状态

kodeks 已经从 Python/FastAPI 原型迁移到 TypeScript workspace。当前实现是 MVP，不是托管型产品。它的目标是保持足够小，方便学习和扩展，同时保留真实 coding agent 需要的关键边界。

旧 Python 实现已经从当前仓库移除；TypeScript workspace 是唯一维护中的 runtime。

## 功能亮点

- Next.js App Router Web 应用和 API routes。
- 基于 Server-Sent Events 的流式对话。
- Moon Bridge Responses provider，可按 DeepSeek 官方 Codex 案例把 DeepSeek 接回 Responses API 形态。
- DeepSeek Chat Completions adapter，支持 Thinking Mode 和 function tool streaming。
- OpenAI Responses API adapter 保留为 fallback provider。
- OpenAI Agents SDK 的 agent/tool wrapper 构造。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs 和 audit logs。
- plan mode 下只暴露 read-only tools。
- 面向 SDK-native 客户端的 Vercel AI SDK UIMessage stream adapter。

## 快速开始

```bash
bun install
bun run dev
```

打开 `http://127.0.0.1:3000`。

Next.js 在 3000 空闲时默认使用 3000 端口。日常本地开发建议显式指定端口，
这样其它项目占用 3000 时也不会影响 kodeks 的访问地址：

```bash
PORT=3001 bun run dev
APP_URL=http://127.0.0.1:3001
```

Windows PowerShell 下：

```powershell
$env:PORT=3001; bun run dev
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

- Moon Bridge 运行时可设置 `KODEKS_MODEL_PROVIDER=moonbridge`；直连 DeepSeek Chat Completions 需要 `DEEPSEEK_API_KEY`；OpenAI Responses fallback 需要 `OPENAI_API_KEY`。

可选：

- `KODEKS_MODEL_PROVIDER` 可选 `moonbridge`、`deepseek` 或 `openai`
- `MOONBRIDGE_ENABLED=true` 也会启用 Moon Bridge Responses 路径
- `MOONBRIDGE_BASE_URL`，默认是 `http://127.0.0.1:38440/v1`
- `MOONBRIDGE_MODEL`，默认是 `moonbridge`
- `MOONBRIDGE_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `DEEPSEEK_BASE_URL`，默认是 `https://api.deepseek.com`
- `DEEPSEEK_MODEL`，默认是 `deepseek-v4-pro`
- `DEEPSEEK_REASONING_EFFORT`，默认是 `high`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `OPENAI_BASE_URL`
- `OPENAI_MODEL`，默认是 `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT`，默认是 `medium`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。

### Moon Bridge + DeepSeek Responses

DeepSeek 官方 Codex 教程推荐用 Moon Bridge 作为本地 Responses-compatible bridge。先启动 Moon Bridge，让它暴露 `http://127.0.0.1:38440/v1/responses`，再这样启动 Kodeks：

```bash
KODEKS_MODEL_PROVIDER=moonbridge bun run dev
```

这个模式下，Kodeks 会发送 Responses API 形态的请求到 Moon Bridge，再由 Moon Bridge 路由到 DeepSeek V4。官方教程见：<https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/codex.md>。

## 开发

```bash
bun run test
bun run typecheck
bun run lint
bun run build
bun run start
```

仓库使用 Bun workspaces：

- `apps/web`: UI、API routes 和 stream adapters。
- `packages/agent-runtime`: turn orchestration、context assembly、plan mode 和 agent/tool wrappers。
- `packages/model`: 在同一个 runtime contract 下提供 Moon Bridge Responses、DeepSeek Chat Completions 和 OpenAI Responses model clients。
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
