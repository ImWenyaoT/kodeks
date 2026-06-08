// frontend/lib/server/routes/deps.ts
// 路由层生产依赖：数据库单例、工作区根解析、容错 body 读取。
// 对应 Python src/kodeks/app.py 的 database() 闭包、resolve_workspace_root()、_json_body()。
// 这些是「薄包装」route handler 注入到 lib/server/routes 纯逻辑函数里的生产实参。
import { resolve } from 'node:path'
import {
  type ArtifactStore,
  BlobArtifactStore,
  createDatabase,
  LocalFileArtifactStore,
  type KodeksDatabase,
} from '../storage'
import {
  type Executor,
  LocalExecutor,
  SandboxExecutor,
} from '../execution'

/** 模块级 lazy singleton（对应 Python app.py state["database"] 闭包缓存）。 */
let databasePromise: Promise<KodeksDatabase> | null = null

/**
 * 解析授权工作区根（移植 resolve_workspace_root，app.py:137-142）。
 * KODEKS_WORKSPACE_ROOT（resolve 成绝对路径）或 process.cwd()（resolve）。
 */
export function resolveWorkspaceRoot(): string {
  const override = process.env.KODEKS_WORKSPACE_ROOT
  if (override) {
    return resolve(override)
  }
  return resolve(process.cwd())
}

/**
 * 解析数据库 URL（移植 database() 闭包的路径逻辑，app.py:67-76）。
 * 优先 TURSO_DATABASE_URL（Turso/serverless）；否则 file: + (KODEKS_DB_PATH 或 <workspaceRoot>/.kodeks/kodeks.sqlite3)。
 */
function resolveDatabaseUrl(): string {
  const tursoUrl = process.env.TURSO_DATABASE_URL
  if (tursoUrl) {
    return tursoUrl
  }
  const dbPath =
    process.env.KODEKS_DB_PATH ??
    resolve(resolveWorkspaceRoot(), '.kodeks', 'kodeks.sqlite3')
  return `file:${dbPath}`
}

/**
 * 选择 artifact 落盘后端（M6 后端切换）。
 * 有 BLOB_READ_WRITE_TOKEN → BlobArtifactStore（Vercel Blob 云端）；否则 LocalFileArtifactStore（本地，默认）。
 * 默认（无云 env）= 本地文件后端，行为与 M2 完全一致。
 */
export function resolveArtifactStore(): ArtifactStore {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN
  if (blobToken) {
    return new BlobArtifactStore(blobToken)
  }
  return new LocalFileArtifactStore(resolveWorkspaceRoot())
}

/**
 * 判断当前 env 是否应启用 Vercel Sandbox 执行后端（纯函数，便于单测）。
 * 条件：运行在 Vercel（VERCEL 置位）且已配置 sandbox 鉴权——
 * 线上 OIDC（VERCEL_OIDC_TOKEN）或 access token（VERCEL_TOKEN）二者其一即可。
 * 不满足（本地开发、无鉴权）一律 false → 退回 LocalExecutor。
 * @param env 进程环境变量快照（注入以便测试，不直接读 process.env）；
 *   用 Record<string, string|undefined> 而非 NodeJS.ProcessEnv，便于测试传部分键的字面量对象。
 */
export function shouldUseSandboxExecutor(env: Record<string, string | undefined>): boolean {
  const onVercel = Boolean(env.VERCEL)
  const hasSandboxAuth = Boolean(env.VERCEL_OIDC_TOKEN) || Boolean(env.VERCEL_TOKEN)
  return onVercel && hasSandboxAuth
}

/**
 * 选择命令执行后端（M6 后端切换）。
 * 满足 shouldUseSandboxExecutor → SandboxExecutor（Vercel microVM）；否则 LocalExecutor（本地，默认）。
 * 默认（无云 env）= 本地 child_process 后端，行为与 M3 完全一致。
 */
export function resolveExecutor(): Executor {
  if (shouldUseSandboxExecutor(process.env)) {
    return new SandboxExecutor()
  }
  return new LocalExecutor()
}

/**
 * 返回进程内共享的 KodeksDatabase 单例（移植 database() 单例缓存，app.py:67-76）。
 * 首次调用建库（含 schema）并缓存 Promise；注入 resolveArtifactStore() 选出的后端，
 * 并在配置了 TURSO_AUTH_TOKEN 时透传给 createDatabase（Turso 远端鉴权，纯增量）。
 */
export function getDatabase(): Promise<KodeksDatabase> {
  if (databasePromise === null) {
    databasePromise = createDatabase(resolveDatabaseUrl(), {
      artifactStore: resolveArtifactStore(),
      authToken: process.env.TURSO_AUTH_TOKEN,
    })
  }
  return databasePromise
}

/**
 * 容错读取请求 JSON body（移植 _json_body，app.py:145-150）。
 * 解析失败或非 dict（数组/标量/null）一律返回 {}；**永不抛 400**（保真风险 13）。
 */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}
