// frontend/app/api/chat/ui/route.ts
// POST /api/chat/ui —— 薄包装：接生产依赖，调 createChatUiResponse（null payload 丢弃语义在逻辑层）。
import {
  createChatUiResponse,
  getDatabase,
  readJsonBody,
  requireControlRequest,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

// Fluid Compute：UI transport 同样是长连 SSE（适配后的事件流跨整段 chat turn）。
// 设 maxDuration=300（秒）放宽函数时长上限，避免长流被平台提前截断。
export const maxDuration = 300

/** 跑一个 Python chat turn 并流式输出 UI transport 适配后的 SSE。 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return createChatUiResponse({
    body,
    database,
    workspaceRoot: resolveWorkspaceRoot(),
    env: process.env as RuntimeEnv,
  })
}
