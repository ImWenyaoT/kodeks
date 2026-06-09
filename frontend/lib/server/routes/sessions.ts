// frontend/lib/server/routes/sessions.ts
// Session 路由逻辑（移植 session_routes.py）：列表 / 创建（201）/ 读取（含 transcript）。
// 存储层契约已是 camelCase 普通对象（无需 Python 的 model_dump(by_alias=True)）。
// 保真红线：POST 必须 201；GET 系列 200；空 id → 400 {detail}；未找到 → 404 {detail}（保真风险 2, 4）。
import { NextResponse } from 'next/server'
import type { KodeksDatabase } from '../storage'

/** 返回 strip 后的非空字符串，否则 null（移植 _string，session_routes.py:70-73）。 */
function string(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

/**
 * 列出会话，每条附 activePlan（移植 list_sessions，session_routes.py:20-33）。
 * activePlan = plans.getActiveBySession(session.id) 或 null。
 * @returns `{sessions: [{...session, activePlan}]}` 的 200 响应。
 */
export async function listSessions(database: KodeksDatabase): Promise<NextResponse> {
  const sessions = await database.sessions.listSessions()
  const payload = []
  for (const session of sessions) {
    const plan = await database.plans.getActiveBySession(session.id)
    payload.push({ ...session, activePlan: plan ?? null })
  }
  return NextResponse.json({ sessions: payload })
}

/**
 * 创建一条会话记录（移植 create_session，session_routes.py:35-48）。
 * title = _string(title) || 'Kodeks session'；mode = body.mode === 'plan' ? 'plan' : 'act'（严格相等，保真风险 4）；
 * session_id = _string(session_id)；workspaceRoot 注入。**状态码 201**（保真风险 2）。
 */
export async function createSession(
  body: Record<string, unknown>,
  database: KodeksDatabase,
  workspaceRoot: string,
): Promise<NextResponse> {
  const session = await database.sessions.createSession(
    string(body.title) ?? 'Kodeks session',
    body.mode === 'plan' ? 'plan' : 'act',
    workspaceRoot,
    string(body.session_id),
  )
  return NextResponse.json({ session }, { status: 201 })
}

/**
 * 读取一条会话 + transcript（移植 get_session，session_routes.py:50-67）。
 * id strip 后为空 → 400 {detail:'Missing session id.'}；未找到 → 404 {detail:'Session not found.'}；
 * 否则 200 {session, messages}。
 */
export async function getSession(
  sessionId: string,
  database: KodeksDatabase,
): Promise<NextResponse> {
  const id = sessionId.trim()
  if (id.length === 0) {
    return NextResponse.json({ detail: 'Missing session id.' }, { status: 400 })
  }
  const session = await database.sessions.getSession(id)
  if (session === null) {
    return NextResponse.json({ detail: 'Session not found.' }, { status: 404 })
  }
  const messages = await database.sessions.getTranscript(id)
  return NextResponse.json({ session, messages })
}
