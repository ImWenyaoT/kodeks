// frontend/app/api/chat/stream/route.ts
// POST /api/chat/stream —— 薄包装：接生产依赖，调 createChatStreamResponse。
import {
  createChatStreamResponse,
  getDatabase,
  readJsonBody,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

/** 跑一个 Python chat turn 并流式输出原始 runtime 事件 SSE。 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return createChatStreamResponse({
    body,
    database,
    workspaceRoot: resolveWorkspaceRoot(),
    env: process.env as RuntimeEnv,
  })
}
