// frontend/app/api/chat/stream/route.ts
// POST /api/chat/stream —— 薄包装：接生产依赖，调 createChatStreamResponse。
import {
  createChatStreamResponse,
  getDatabase,
  readJsonBody,
  requireControlRequest,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

// Fluid Compute：聊天是长连 SSE（一个 turn 可能跑数十秒到数分钟的工具/模型往返），
// 默认函数时长不足以撑住整段流。设 maxDuration=300（秒）放宽上限，避免长流被平台提前截断。
export const maxDuration = 300

/** 跑一个 Python chat turn 并流式输出原始 runtime 事件 SSE。 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return createChatStreamResponse({
    body,
    database,
    workspaceRoot: resolveWorkspaceRoot(),
    env: process.env as RuntimeEnv,
  })
}
