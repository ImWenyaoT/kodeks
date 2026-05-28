import type { NextRequest } from 'next/server';

import {
  getKodeksDatabase,
  getKodeksWorkspace
} from '@/lib/server/kodeks-runtime';

// Next.js API routes 需要 Node runtime 以访问本地文件系统和 SQLite。
export const runtime = 'nodejs';

// 列出当前本地 Kodeks workspace 已知的 sessions。
export async function GET(): Promise<Response> {
  const database = getKodeksDatabase();
  const sessions = await database.sessions.listSessions();
  const sessionsWithPlans = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      activePlan: await database.plans.getActiveBySession(session.id)
    }))
  );
  return Response.json({ sessions: sessionsWithPlans });
}

// 创建一个 session record，用于 resume 和显式 mode tracking。
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : 'Kodeks session';
  const mode = body.mode === 'plan' ? 'plan' : 'act';
  const id =
    typeof body.session_id === 'string' && body.session_id.trim()
      ? body.session_id.trim()
      : undefined;
  const session = await getKodeksDatabase().sessions.createSession({
    id,
    title,
    mode,
    workspaceRoot: getKodeksWorkspace().rootPath()
  });

  return Response.json({ session }, { status: 201 });
}
