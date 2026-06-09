# kodeks

**kodeks** 是一个 local-first 的编码 agent 工作台。范围刻意做小:带记忆、多会话状态、
子代理探索、plan 模式、工作区工具、人工审批,以及一个面向 OpenAI 兼容 Chat Completions 的
协议适配器(默认上游 DeepSeek)。

> **运行时:TypeScript / Next.js。** kodeks 已从最初的 Python/FastAPI 后端迁移为单个 Next.js
> 全栈应用(App Router route handlers + `frontend/lib/server`)。与 Python 原版的行为一致性由
> [`oracle/`](./oracle/README.md) 下的字节级黄金 fixtures 钉死。Python 源码已退役,需要时查 git 历史。

[English README](./README.md) · [架构](./docs/architecture.md) · [部署](./frontend/DEPLOY.md) · [Oracle 黄金基准](./oracle/README.md)

## 产品边界

kodeks 不是通用 agent 平台:不做 web 搜索、provider 面板、插件市场或宽泛的托管 agent。
它的价值在于展示一套**紧凑但认真**的 LLM harness:

- **状态管理**:会话、transcript 重放、计划、记忆、artifact、审批、子代理运行记录;
- **流程控制**:流式 turn、工具调用、工具结果续跑、plan 模式只读过滤、终止错误;
- **人工审批**:危险 shell 执行落为可审计、一次性的审批决策;
- **可观测**:SSE runtime 事件 + 审计日志;
- **多代理形态**:只读子代理探索 + 持久化摘要;
- **协议集成**:Responses 形态的 runtime 契约 + MoonBridge 转 OpenAI 兼容 Chat Completions。

设计重心是 harness 理解力:context 装配、工具、权限、状态、协议形态、评估。

## 架构

单个 Next.js 应用。浏览器 UI(React 19 + Tailwind v4 + shadcn/ui + Zustand)与后端运行时
同在 `frontend/`,经**同源 fetch** 通信。

```
frontend/
  app/                       Next.js App Router
    page.tsx, layout.tsx     React UI(迁移全程未改)
    api/**/route.ts          HTTP 路由壳(Node runtime,薄包装)
  lib/server/                后端运行时(从 Python 移植)
    wire/                    SSE 帧编码 + runtime/UI 事件契约(Zod)
    bridge/                  MoonBridge:Responses <-> Chat Completions(DeepSeek)
    config.ts, model-config  env/dotenv/模型目录/provider 解析
    storage/                 libSQL 仓库(会话/记忆/审批/计划/...)
    tools/                   9 个模型工具 + 注册表(read/write/grep/run_shell/...)
    workspace.ts             路径沙箱 + 危险命令策略 + argv 执行
    agent/                   turn 循环、工具续跑、context 装配、harness
    routes/                  可注入的路由逻辑(chat/sessions/approvals/...)
    execution/               命令执行后端(本地 / Vercel Sandbox)
oracle/                      行为黄金基准 fixtures(见 oracle/README.md)
```

模型上游**进程内**到达:运行时直接调桥
(`fromDeepseekStream(fetchChatCompletionsStream(toDeepseekChatRequest(...)))`),无自调 HTTP 跳转。
默认上游是经 MoonBridge 的 DeepSeek。

## 快速开始

```bash
cd frontend
npm install
```

把 DeepSeek 凭据放进 `frontend/.env.local`(Next.js 会自动加载):

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

启动开发服务器,打开 `http://localhost:3000`:

```bash
npm run dev
```

健康检查与一次 SSE 聊天流:

```bash
curl http://localhost:3000/health
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"你好","session_id":"s_demo","mode":"act"}'
```

## 配置

必需:一个 OpenAI 兼容 Chat Completions API key,经 MoonBridge 路由。默认上游 DeepSeek。

优先级:

1. 显式进程环境变量
2. 项目 `.env`(设了 `KODEKS_WORKSPACE_ROOT` 时读工作区根 `.env`)
3. 结构化配置文件(`.kodeks/config.json`,再 `~/.kodeks/config.json`)

常用项:

- `API_KEY` / `DEEPSEEK_API_KEY` → `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `BASE_URL` / `DEEPSEEK_BASE_URL`(默认 `https://api.deepseek.com`)
- `MODEL` / `DEEPSEEK_MODEL`(默认 `deepseek-v4-pro`;目录含 `deepseek-v4-pro` 与 `deepseek-v4-flash`)
- `KODEKS_BRIDGE_REASONING_EFFORT` ∈ `none|low|medium|high|xhigh`
- `KODEKS_WORKSPACE_ROOT`、`KODEKS_DB_PATH`

持久化:默认本地 libSQL 文件 `.kodeks/kodeks.sqlite3`。serverless/生产时设 `TURSO_DATABASE_URL`
(+`TURSO_AUTH_TOKEN`)作数据库、`BLOB_READ_WRITE_TOKEN`(Vercel Blob)存大记忆 artifact,
部署到 Vercel——见 [`frontend/DEPLOY.md`](./frontend/DEPLOY.md)。

## MoonBridge

MoonBridge 是内部协议适配器(`frontend/lib/server/bridge/`)。运行时保持 Responses 形态契约,
同时把请求(`instructions`/`input`/`tools`/`reasoning.effort`)转成 Chat Completions,并把流式
`chat.completion.chunk` 映射回 Responses 事件,工具调用回合上保留 DeepSeek 的 `reasoning_content`。

## 开发

全部命令在 `frontend/` 下:

```bash
cd frontend
npm test            # vitest(309 测试,含 oracle 重放)
npm run lint        # eslint
npx tsc --noEmit    # 类型检查
npm run build       # next build
```

CI 跑同样的门禁(`.github/workflows/ci.yml`)。

### 行为一致性(oracle)

[`oracle/`](./oracle/README.md) 存放从原 Python 后端录制的行为黄金快照(事件序列、逐字节 SSE、
审计行),覆盖 14 个场景。TS 测试重放它们并断言**逐字节等价**——这就是迁移如何证明新运行时与旧后端
行为一致。

## 安全模型

kodeks 把本地能力视为特权:

- 文件访问受工作区策略约束。
- `.git`、`.kodeks`、依赖目录、虚拟环境等内部路径被阻断。
- 危险 shell 命令落为审批记录而非立即执行。
- 审批决策可审计、一次性。

这是本地开发项目。在敏感仓库上使用前请先审阅策略与存储代码。

## 文档

- [`frontend/DEPLOY.md`](./frontend/DEPLOY.md):Vercel 部署 runbook(Turso/Blob/Sandbox)。
- [`oracle/README.md`](./oracle/README.md):行为黄金 fixtures。
- [`docs/architecture.md`](./docs/architecture.md):harness 设计与产品边界(概念层,早于 TS 迁移)。

## 许可

[MIT](./LICENSE)
