# Kodeks 部署说明（双进程：Python 后端 + Next.js 前端）

当前架构是**两个进程**：

- **Python/FastAPI 后端**（`src/kodeks/**`，常驻进程，默认 `:8000`）——承载 HTTP API、chat runtime、本地工具执行，持久化用本地 SQLite，命令执行用本地 `subprocess`（带审批门控）。
- **Next.js/React 前端**（`frontend/`，默认 `:3000`）——只渲染 UI，经 `next.config.ts` 的 `rewrites()` 把 `/api/*` 反向代理到后端。浏览器全程同源，无需 CORS。

> ⚠️ **生产部署当前为暂缓（deferred）状态**：本仓库尚未提供生产部署的脚本/配置。本文档给出本地运行方式与若干可行的生产形态供参考，但**不代为执行**云端 provision/deploy。
>
> 注意：迁移前的「单个 Next.js 应用一键部署到 Vercel + Turso/Blob/Sandbox 按 env 透明切换云端后端」的形态**已不适用**——那套云端后端是 TS 实现（`frontend/lib/server/`），已随后端回退到 Python 而删除。Python 后端是常驻服务，不是 Vercel Function。

---

## 1. 本地运行（开发）

仓库根目录一条命令同时拉起两个进程：

```bash
uv run scripts/dev.py          # uvicorn :8000 + next dev :3000，统一日志、Ctrl-C 收尾
```

或两个终端手动启动：

```bash
# 终端 1 —— Python 后端（仓库根目录）
uv sync
uv run kodeks-server --reload --port 8000

# 终端 2 —— Next.js 前端
cd frontend && npm install && npm run dev
```

浏览器打开 `http://localhost:3000`。凭据放仓库根 `.env`（见根 `.env.example`，至少 `DEEPSEEK_API_KEY`）。

---

## 2. 必填环境变量

详见仓库根 [`.env.example`](../.env.example)。最小集：

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek（OpenAI 兼容）API key；经 `config.py` 的 `MODEL_ENV_ALIASES` 映射到 `KODEKS_CHAT_COMPLETIONS_API_KEY`。 |
| `DEEPSEEK_BASE_URL` | 上游 base URL，默认 `https://api.deepseek.com`。 |
| `KODEKS_API_ORIGIN` | **前端进程读取**：`next.config.ts` 据此把 `/api/*` 反代到后端。本地缺省 `http://127.0.0.1:8000`；生产指向独立部署的 Python 服务。 |

可选：`DEEPSEEK_MODEL`、`KODEKS_DB_PATH`（本地 SQLite 路径，缺省 `<workspace>/.kodeks/kodeks.sqlite3`）、`KODEKS_WORKSPACE_ROOT`、`KODEKS_CORS_ORIGINS`（同源 rewrites 架构下无需设置）。

---

## 3. 生产形态（参考，未实现）

按对 SSE 长连与运维复杂度的取舍，三种可行形态：

1. **双 Host（推荐）**：前端 `frontend/` 部署到任意静态/SSR 平台（如 Vercel，Root Directory 设 `frontend`）；Python 后端用容器/VM 跑 `uvicorn`（Fly.io / Railway / Render / 自建 VM）。前端设 `KODEKS_API_ORIGIN=https://<python-host>`，由 rewrites 跨 host 反代。
   - **SSR 平台代理长 SSE 有超时/缓冲风险**：`/api/chat/stream` 是无 `[DONE]` 终止符、靠连接关闭收尾的长流。若平台代理会截断，需让前端的聊天流**直连** Python host（此时要在 Python 设 `KODEKS_CORS_ORIGINS` 并给该调用用绝对 URL）。
2. **单 Host（nginx/Caddy）**：一台机器上同时跑 `next start` 与 `uvicorn`，由 nginx 反代 `/api → :8000`，对 SSE 路由设 `proxy_buffering off`、`gzip off`、无读超时。最接近原单源模型，但 UI 由 Node 提供。
3. **Python 直接服务 UI（回到单进程）**：`next build` 产物同步进 `src/kodeks/static/`，由 FastAPI 在 `/` 提供。消除双进程，但失去 Next 的 SSR/动态路由。仅在确需单进程时采用。

---

## 4. SSE 反代注意事项

- 本地 `next dev` / `next start` 的 rewrites 默认**不缓冲**、流式透传，开箱即用。
- 任何前置 CDN/压缩/代理层都需对 `/api/chat/stream`（和 `/api/chat/ui`）关闭缓冲与压缩、取消读超时，否则长流可能被截断。
- 后端自身不发 `Cache-Control`/`X-Accel-Buffering`；如前置 nginx，按需在边界补 `X-Accel-Buffering: no`。

---

## 5. 已移植 / 暂缓的安全加固

f5376fe（TS 时期的「Harden approvals/control gates/live eval」）回退后，已移植到 Python 的部分：

- **审批命令哈希绑定**：approve 必须带 `expectedCommandHash`，后端核验 = `sha256(待执行命令)`，缺失/不匹配 → 409。事件下发 `command`+`command_hash`，UI 展示并回传。
- **failed 终态**：审批命令执行失败落 `failed` 态（不再悬停 approved）。
- **plan-mode 工具白名单**：plan 模式在执行层硬性拦截写类工具（`tool_not_allowed_in_mode`）。

**暂缓（已知 gap，下一轮按需补）**：

- **控制面门控（origin + `KODEKS_CONTROL_TOKEN`）**：当前 Python 仅绑定 `127.0.0.1:8000`，且只经本地 Next rewrites 代理访问（浏览器不直连），故暂不需要。**一旦把 Python 暴露到 localhost 之外**，必须在 `/api/*`（尤其审批执行）前加 origin 同源校验 + token 鉴权；注意 rewrites 代理后 FastAPI 看到的是代理 host，需读 `X-Forwarded-*` 或改为纯 token 方案。
- **危险命令策略升级**：对解释器/下载器（bash/python/curl/node-eval…）与越界绝对路径 argv 强制审批（f5376fe 的 `commandPolicy`）。当前 Python 仍只走正则黑名单 + shell 元字符拦截。
- **服务端重读选中文件 / 剥离 client `instructions`·`provider`**：f5376fe 让后端只接受文件 path 并自行重读内容、丢弃客户端注入的 instructions/provider。Python 现有契约**有意**保留用户可填的 `instructions` 字段，故未照搬；如要防注入需同时改 UI 契约。
- **live-coding eval 语料**：f5376fe 的 `evals/live-coding-tasks.json`（63 任务）是 TS 运行器格式，已随清理移除（git 历史可取回）；如需，应按 Python `evals/run_local.py` 的格式重做。
