// frontend/app/api/chat/ui/route.ts
// POST /api/chat/ui —— 薄包装：接生产依赖，调 createChatUiResponse（null payload 丢弃语义在逻辑层）。
import {
  createChatUiResponse,
  getDatabase,
  readJsonBody,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

/** 跑一个 Python chat turn 并流式输出 UI transport 适配后的 SSE。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return createChatUiResponse({
    body,
    database,
    workspaceRoot: resolveWorkspaceRoot(),
    env: process.env as RuntimeEnv,
  })
}
