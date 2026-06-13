# kodeks

**kodeks** 是一个 local-first 的编码 agent 工作台。范围刻意做小:带记忆、多会话状态、
子代理探索、plan 模式、工作区工具、人工审批,以及一个面向 OpenAI 兼容 Chat Completions 的
协议适配器(默认上游 DeepSeek)。

> **运行时:Python/FastAPI 后端 + Next.js 前端(两个进程)。** HTTP API、聊天运行时与本地工具
> 执行作为 Python/FastAPI 服务运行(`src/kodeks/**`,端口 8000)。浏览器 UI 是独立的 Next.js/React
> 应用(`frontend/`,端口 3000),经 `frontend/next.config.ts` 的 rewrites 把 `/api/*` 反代到 Python
> 后端——浏览器全程同源,无需 CORS。行为由 [`oracle/`](./oracle/README.md) 下的字节级黄金 fixtures 钉死。

[English README](./README.md) · [架构说明](./docs/architecture.md) · [产品需求](./docs/PRD.md) · [概念映射](./docs/concepts-map.md) · [部署](./frontend/DEPLOY.md) · [Oracle 黄金基准](./oracle/README.md)

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

两个进程。Python/FastAPI 后端(`src/kodeks/**`,端口 8000)承载 HTTP API、聊天运行时与
本地工具执行。Next.js/React 前端(`frontend/`,端口 3000;React 19 + Tailwind v4 + shadcn/ui
+ Zustand)单独提供浏览器 UI。前端经 `frontend/next.config.ts` 的 rewrites 把 `/api/*` 反代到
后端,浏览器全程同源,无需 CORS。

```
src/kodeks/                  Python/FastAPI 后端(端口 8000)
  app.py                     FastAPI app + 路由挂载
  server.py                  uvicorn 入口(kodeks-server)
  api/                       chat/session/approval/bridge/workspace 路由
    sse.py, ui_transport.py  SSE 帧编码 + runtime/UI 事件传输
  runtime.py, responses_runtime.py, responses_tool_loop.py, harness.py
                             agent 循环(turn 循环、工具续跑、context 装配)
  tools/                     模型工具:registry / schemas / helpers
  storage/                   db / session / memory(SQLite)
  providers/bridge.py        MoonBridge:Responses <-> Chat Completions(DeepSeek)
  config.py, model_config.py env/dotenv/模型目录/provider 解析
  workspace.py               路径沙箱 + 危险命令策略 + argv 执行
  plans.py                   plan 模式状态
frontend/                    Next.js/React 前端(端口 3000)
  app/                       Next.js App Router:page.tsx, layout.tsx
  components/                React UI
  hooks/                     useModels / useSessions / useChatStream /
                             useApprovals / useBridgePreflight
  stores/                    Zustand 状态
  lib/                       api.ts / sse.ts / events.ts / i18n.ts / format.ts
                             (纯客户端)
  next.config.ts             rewrites() 把 /api/* 反代到 127.0.0.1:8000
oracle/                      行为黄金基准 fixtures(见 oracle/README.md)
```

前端如何到达后端:React 客户端(`frontend/lib/api.ts`)调用相对路径 `/api/*`。
`frontend/next.config.ts` 的 `rewrites()` 把 `/api/*`(以及 `/health`、`/v1/*`、`/responses`、
`/models`、`/bridge/health`)反代到 `http://127.0.0.1:8000`(可用环境变量 `KODEKS_API_ORIGIN`
覆盖)。聊天流是 POST + `fetch` `ReadableStream` SSE。默认模型上游是经 MoonBridge 的 DeepSeek。

## 快速开始

两半都要装——Python 后端(仓库根目录)与 Next.js 前端(`frontend/`):

```bash
uv sync                 # Python 后端依赖(仓库根目录)
cd frontend && npm install && cd ..
```

把 DeepSeek 凭据放进**仓库根目录的 `.env`**(Python 后端从其 cwd / 仓库根读 `.env`)。
复制模板并填入 key:

```bash
cp .env.example .env
```

```dotenv
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

(`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`会映射到
`KODEKS_CHAT_COMPLETIONS_*`。`KODEKS_API_ORIGIN` 可选,仅前端进程读取——本地缺省即可。)

一条命令同时拉起两个进程,然后打开 `http://localhost:3000`:

```bash
uv run scripts/dev.py   # 同时起 uvicorn :8000 + next dev :3000,日志加前缀,
                        # Ctrl-C 传播到两者
```

或在两个终端里分别手动启动:

```bash
# 终端 1 —— Python 后端(仓库根目录)
uv run kodeks-server --reload --port 8000

# 终端 2 —— Next.js 前端
cd frontend && npm run dev
```

打开 UI：`http://localhost:3000`。直接对 :8000 后端做冒烟检查(前端在 :3000 反代同样的路由):

```bash
curl http://127.0.0.1:8000/health
curl -N -X POST http://127.0.0.1:8000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"你好","session_id":"s_demo","mode":"act"}'
```

## 配置

必需:一个 OpenAI 兼容 Chat Completions API key,经 MoonBridge 路由。默认上游 DeepSeek。
凭据放在仓库根目录的 `.env`,Python 后端从其 cwd / 仓库根加载(`config.py`)。

优先级:

1. 显式进程环境变量
2. 仓库根目录的 `.env`(由 Python 后端读取)
3. 结构化配置文件(`.kodeks/config.json`,再 `~/.kodeks/config.json`)

常用项:

- `API_KEY` / `DEEPSEEK_API_KEY` → `KODEKS_CHAT_COMPLETIONS_API_KEY`
- `BASE_URL` / `DEEPSEEK_BASE_URL`(默认 `https://api.deepseek.com`)
- `MODEL` / `DEEPSEEK_MODEL`(默认 `deepseek-v4-pro`;目录含 `deepseek-v4-pro` 与 `deepseek-v4-flash`)
- `KODEKS_BRIDGE_REASONING_EFFORT` ∈ `none|low|medium|high|xhigh`
- `KODEKS_WORKSPACE_ROOT`、`KODEKS_DB_PATH`
- `KODEKS_API_ORIGIN`(仅前端进程;前端把 `/api/*` 反代到此处;默认
  `http://127.0.0.1:8000`)。可选——若要设,可放进 `frontend/.env.local`。

持久化:Python 后端默认在本地 SQLite 文件 `.kodeks/kodeks.sqlite3`(用 `KODEKS_DB_PATH` 覆盖)。
部署相关见 [`frontend/DEPLOY.md`](./frontend/DEPLOY.md)。

## MoonBridge

MoonBridge 是内部协议适配器(`src/kodeks/providers/bridge.py`,经
`src/kodeks/api/bridge_routes.py` 暴露)。运行时保持 Responses 形态契约,
同时把请求(`instructions`/`input`/`tools`/`reasoning.effort`)转成 Chat Completions,并把流式
`chat.completion.chunk` 映射回 Responses 事件,工具调用回合上保留 DeepSeek 的 `reasoning_content`。

## 开发

后端命令在仓库根目录下:

```bash
uv sync
uv run ruff check
uv run mypy
uv run pytest
uv run python -m kodeks.smoke --in-process   # 离线冒烟检查
uv build                                      # 构建包
```

前端命令在 `frontend/` 下:

```bash
cd frontend
npm install
npm run lint        # eslint
npm test            # vitest
npm run build       # next build
```

CI 跑同样的门禁(`.github/workflows/ci.yml`)。

### 行为一致性(oracle)

[`oracle/`](./oracle/README.md) 存放行为黄金快照(事件序列、逐字节 SSE、审计行),覆盖 14 个场景。
Python 测试 `tests/test_route_parity.py` 重放它们并断言**逐字节等价**,把后端行为钉死在这些 fixtures 上。

## 安全模型

kodeks 把本地能力视为特权:

- 文件访问受工作区策略约束。
- `.git`、`.kodeks`、依赖目录、虚拟环境等内部路径被阻断。
- 危险 shell 命令落为审批记录而非立即执行。
- 审批决策可审计、一次性。

这是本地开发项目。在敏感仓库上使用前请先审阅策略与存储代码。

## 文档

- [`frontend/DEPLOY.md`](./frontend/DEPLOY.md):部署 runbook。
- [`oracle/README.md`](./oracle/README.md):行为黄金 fixtures。
- [`docs/architecture.md`](./docs/architecture.md):harness 设计与产品边界(概念层)。

## 许可

[MIT](./LICENSE)
