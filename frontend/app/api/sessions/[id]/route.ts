// frontend/app/api/sessions/[id]/route.ts
// GET /api/sessions/{id} —— 薄包装。Next 16 的 params 是 Promise。
import { NextResponse } from 'next/server'
import { getDatabase, getSession, requireControlRequest } from '@/lib/server/routes'

export const runtime = 'nodejs'

/** 读取一条会话 + transcript。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const { id } = await params
  const database = await getDatabase()
  return getSession(id, database)
}
