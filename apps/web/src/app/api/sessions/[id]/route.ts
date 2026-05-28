import type { NextRequest } from 'next/server';

import { getKodeksDatabase } from '@/lib/server/kodeks-runtime';

// Next.js API routes 需要 Node runtime 以访问本地文件系统和 SQLite。
export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

// 读取一个 session 的元数据和 transcript，供左侧历史会话恢复当前聊天视图。
export async function GET(
  _request: NextRequest,
  context: RouteContext
): Promise<Response> {
  const params = await context.params;
  const sessionId = params.id.trim();
  if (!sessionId) {
    return Response.json({ error: 'Missing session id.' }, { status: 400 });
  }

  const database = getKodeksDatabase();
  const session = await database.sessions.getSession(sessionId);
  if (session === null) {
    return Response.json({ error: 'Session not found.' }, { status: 404 });
  }

  const messages = await database.sessions.getTranscript(sessionId);
  return Response.json({ session, messages });
}
