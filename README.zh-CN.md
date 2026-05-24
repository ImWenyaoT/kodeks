# kodeks

**kodeks** 是一个 local-first 的 TypeScript coding agent runtime，用来实验现代软件工程 agent 的核心闭环：流式对话、workspace tools、shell approval、memory、session、plan mode 和 subagent exploration。

[English README](./README.md) · [产品需求](./docs/PRD.md) · [迁移设计](./docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md)

## 当前状态

kodeks 已经从 Python/FastAPI 原型迁移到 TypeScript workspace。当前实现是 MVP，不是托管型产品。它的目标是保持足够小，方便学习和扩展，同时保留真实 coding agent 需要的关键边界。

原 Python 实现已经归档在 [`legacy/python/`](./legacy/python/)。

## 功能亮点

- Next.js App Router Web 应用和 API routes。
- 基于 Server-Sent Events 的流式对话。
- OpenAI Responses API adapter，支持 function tool streaming。
- OpenAI Agents SDK 的 agent/tool wrapper 构造。
- 受 workspace policy 约束的文件工具，并阻止内部路径访问。
- 带 timeout 和危险命令检测的 shell harness。
- 基于 SQLite 的 sessions、transcripts、memories、approvals、subagent runs 和 audit logs。
- plan mode 下只暴露 read-only tools。
- 面向 SDK-native 客户端的 Vercel AI SDK UIMessage stream adapter。

## 快速开始

```bash
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:3000`。

健康检查：

```bash
curl http://127.0.0.1:3000/api/sessions
```

SSE chat stream：

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

Vercel AI SDK UIMessage stream：

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat/ui-stream \
  -H "Content-Type: application/json" \
  -d '{"input":"hello","session_id":"s_demo","mode":"act"}'
```

## 配置

必需：

- `OPENAI_API_KEY`

可选：

- `OPENAI_BASE_URL`
- `OPENAI_MODEL`，默认是 `gpt-5.4-mini`
- `OPENAI_REASONING_EFFORT`，默认是 `medium`；支持 `none`、`low`、`medium`、`high`、`xhigh`
- `KODEKS_WORKSPACE_ROOT`
- `KODEKS_DB_PATH`

运行时状态默认写入 `.kodeks/`，并且不会进入 Git。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

仓库使用 `pnpm` workspaces：

- `apps/web`: UI、API routes 和 stream adapters。
- `packages/agent-runtime`: turn orchestration、context assembly、plan mode 和 agent/tool wrappers。
- `packages/model`: OpenAI Responses API model client。
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
