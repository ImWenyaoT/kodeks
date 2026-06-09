// frontend/app/api/sessions/route.ts
// GET /api/sessions（列表）+ POST /api/sessions（创建，201）—— 薄包装。
import { NextResponse } from 'next/server'
import {
  createSession,
  getDatabase,
  listSessions,
  readJsonBody,
  requireControlRequest,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'

export const runtime = 'nodejs'

/** 列出会话（含 activePlan）。 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const database = await getDatabase()
  return listSessions(database)
}

/** 创建一条会话记录（201）。 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return createSession(body, database, resolveWorkspaceRoot())
}
