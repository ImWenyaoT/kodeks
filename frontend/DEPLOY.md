# Kodeks 部署 Runbook（Vercel 生产）

本文档面向把 `frontend/`（Next.js App Router）部署到 Vercel 生产环境。代码已做到「一配 env 即可部署」：
**不配任何云端 env → 全本地后端，行为与本地开发一致**；按需配置对应 env → 透明切换到云端后端。

> 范围：本文只覆盖**需要 provision 的资源**与**需要配置的 env 变量**。实际的云端 provision/deploy 命令请你按各自控制台/CLI 执行——本仓库不代为执行。

---

## 1. 需要 provision 的资源

| 资源 | 用途 | 何时需要 | 产出的凭据 |
| --- | --- | --- | --- |
| **DeepSeek API key** | 模型 / 工具往返的上游（OpenAI 兼容） | 始终（本地 + 线上） | `DEEPSEEK_API_KEY` |
| **Turso 数据库**（libSQL） | 会话 / 审批 / 计划 / 审计 / 记忆等持久化 | 线上（serverless 无持久磁盘） | `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` |
| **Vercel Blob store** | 卸载的大体积内存 artifact 正文存储 | 线上（serverless 无持久磁盘） | `BLOB_READ_WRITE_TOKEN` |
| **Vercel Sandbox** | 审批后命令在隔离 microVM 内执行 | 线上（serverless 无法直接 spawn 子进程跑工作区命令） | OIDC 自动 / `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID` |

provision 提示：

- **Turso**：用 Turso CLI 建库并生成 token（`turso db create`、`turso db tokens create`），URL 形如 `libsql://<db>-<org>.turso.io`。
- **Vercel Blob**：在 Vercel 项目的 Storage 里创建 Blob store；`BLOB_READ_WRITE_TOKEN` 会作为项目 env 自动注入（也可手动复制）。
- **Vercel Sandbox**：部署在 Vercel 上时，OIDC 鉴权（`VERCEL_OIDC_TOKEN`）由平台自动注入，**无需手填**；仅在非 Vercel 环境（外部 CI/自托管）才需 access token 三件套。

---

## 2. 需要配置的 env 变量清单

> 详见仓库根 `.env.example`（只含变量名 + 占位说明）。

### 必填（本地 + 线上）

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API key。 |
| `DEEPSEEK_BASE_URL` | 上游 base URL，默认 `https://api.deepseek.com`。 |
| `DEEPSEEK_MODEL` | 可选，覆盖默认模型名。 |

### 线上持久化（不配则回退本地）

| 变量 | 配置后效果 | 不配（默认） |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | 用 Turso 远端 libSQL 库 | 本地 `file:` SQLite（`KODEKS_DB_PATH` 或 `workspace/.kodeks/kodeks.sqlite3`） |
| `TURSO_AUTH_TOKEN` | Turso 远端鉴权（连 `libsql://` 时必需） | 本地 `file:` 无需 token |
| `BLOB_READ_WRITE_TOKEN` | 内存 artifact 存进 Vercel Blob（`BlobArtifactStore`） | 本地 `.kodeks/memory-artifacts`（`LocalFileArtifactStore`） |

### Vercel Sandbox 执行（审批命令）

| 变量 | 说明 |
| --- | --- |
| `VERCEL` | 部署在 Vercel 时平台自动置位（=1）。判定是否启用 Sandbox 后端的前置条件之一。 |
| `VERCEL_OIDC_TOKEN` | Vercel 线上自动注入；本地用 `vercel env pull` 拉取（12h 过期）。 |
| `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` | 仅非 Vercel 环境（外部 CI/自托管）用 Sandbox 时改用的 access token 三件套。 |

---

## 3. 本地 vs 线上后端切换说明

后端切换是**纯 env 驱动**的，代码里有三处选择点（`frontend/lib/server/routes/deps.ts`）：

1. **数据库**（`getDatabase` → `resolveDatabaseUrl` + `authToken`）
   - 有 `TURSO_DATABASE_URL` → 连 Turso 远端，并透传 `TURSO_AUTH_TOKEN`。
   - 否则 → 本地 `file:` SQLite。
2. **Artifact 存储**（`resolveArtifactStore`）
   - 有 `BLOB_READ_WRITE_TOKEN` → `BlobArtifactStore`（artifact 句柄是 Blob 公网 URL）。
   - 否则 → `LocalFileArtifactStore`（句柄是本地绝对路径）。
3. **命令执行**（`resolveExecutor` → `shouldUseSandboxExecutor`）
   - `VERCEL` 置位 **且**（`VERCEL_OIDC_TOKEN` 或 `VERCEL_TOKEN`）→ `SandboxExecutor`（Firecracker microVM，argv 无 shell）。
   - 否则 → `LocalExecutor`（`child_process.execFile`，argv 无 shell）。

> 三种云端后端的**返回/接口形状与本地版逐字一致**，是透明替换：上层 wire/bridge/agent/tools 逻辑完全不感知后端差异。

**本地默认（不配任何云端 env）= 全 local 后端。** 既有测试套件全部运行在 local 后端上、零回归。

---

## 4. preview → prod 部署步骤

1. **链接项目**（一次）：`vercel link`，把本仓库的 `frontend/` 关联到 Vercel 项目（Root Directory 设为 `frontend`）。
2. **配置 env**：在 Vercel 项目 Settings → Environment Variables 里，按上面第 2 节为 **Preview** 和 **Production** 分别填入变量。
   - DeepSeek 段：两套环境都填。
   - Turso / Blob / Sandbox 段：建议 Preview 与 Production **使用各自独立的库/store**，避免互相污染数据。
3. **拉取本地凭据**（如需本地连云端调试）：`vercel env pull`，生成 `.env.local`（含 `VERCEL_OIDC_TOKEN`，12h 过期，过期重拉）。
4. **Preview 部署**：推到非默认分支触发 preview 部署（或 `vercel deploy`）。先在 preview 上跑完第 5 节验证清单。
5. **Promote 到 Production**：preview 验证通过后，合并到默认分支触发生产部署（或 `vercel deploy --prod` / 在控制台 Promote）。

> 长连 SSE：`/api/chat/stream` 与 `/api/chat/ui` 已 `export const maxDuration = 300`（Fluid Compute 放宽函数时长上限），无需额外 `vercel.json`。两路由保留 `runtime = 'nodejs'`。

---

## 5. 冷启动后 会话/记忆持久化验证清单

部署后（尤其首次冷启动），按下表逐项验证云端后端确实生效、且重启不丢数据：

- [ ] **建会话**：POST `/api/sessions` 创建一个会话，记下 `id`。
- [ ] **持久化跨冷启动**：等函数实例回收（或触发新部署）后，GET `/api/sessions/{id}` 仍能取回该会话 → 证明数据落在 Turso 而非实例本地磁盘。
- [ ] **会话列表稳定**：GET `/api/sessions` 在多次冷启动间返回一致的历史会话集。
- [ ] **记忆 artifact 卸载到 Blob**：触发一次产出 >4KB 工具输出的 chat turn；确认返回的紧凑 JSON 含 `offloaded:true` 与 `refId`，且对应 `memory_artifacts.file_path` 是 `https://...blob...` 形态的 Blob URL（而非本地路径）。
- [ ] **记忆 artifact 可回读**：通过记忆召回/读取路径取回该 artifact 正文，内容完整 → 证明 `BlobArtifactStore.read` 能 fetch 回 Blob URL。
- [ ] **审批命令在 Sandbox 执行**：发起一条需审批的命令，approve 后确认返回的 `result`（`exitCode`/`stdout`/`stderr`/`*Truncated`）形状正常 → 证明 `SandboxExecutor` 已透明替换 `LocalExecutor`。
- [ ] **审批超时一致**：构造一个会超时的审批命令，确认返回 408 `{detail}`（与本地 `ShellCommandTimeoutError` 行为一致）。
- [ ] **长 SSE 不被截断**：跑一个较长的 chat turn，确认 SSE 流完整结束（未在中途被平台超时切断）→ 证明 `maxDuration=300` 生效。

任一项失败时，回到第 2/3 节核对对应 env 是否在该环境（Preview/Production）正确配置。
