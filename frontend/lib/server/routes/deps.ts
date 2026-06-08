// frontend/lib/server/routes/deps.ts
// 路由层生产依赖：数据库单例、工作区根解析、容错 body 读取。
// 对应 Python src/kodeks/app.py 的 database() 闭包、resolve_workspace_root()、_json_body()。
// 这些是「薄包装」route handler 注入到 lib/server/routes 纯逻辑函数里的生产实参。
import { resolve } from 'node:path'
import {
  createDatabase,
  LocalFileArtifactStore,
  type KodeksDatabase,
} from '../storage'

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
 * 返回进程内共享的 KodeksDatabase 单例（移植 database() 单例缓存，app.py:67-76）。
 * 首次调用建库（含 schema）并缓存 Promise；注入 LocalFileArtifactStore(workspaceRoot)。
 */
export function getDatabase(): Promise<KodeksDatabase> {
  if (databasePromise === null) {
    databasePromise = createDatabase(resolveDatabaseUrl(), {
      artifactStore: new LocalFileArtifactStore(resolveWorkspaceRoot()),
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
