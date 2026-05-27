import { NextRequest } from "next/server";

import { getKodeksDatabase, getKodeksWorkspace } from "@/lib/server/kodeks-runtime";

// Next.js 的 nodejs runtime 标签和 Bun 包管理/启动方式不冲突；本地仍通过 bun --bun next 运行。
export const runtime = "nodejs";

// 列出当前本地 Kodeks workspace 已知的 sessions。
export async function GET(): Promise<Response> {
  const sessions = await getKodeksDatabase().sessions.listSessions();
  return Response.json({ sessions });
}

// 创建一个 session record，用于 resume 和显式 mode tracking。
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Kodeks session";
  const mode = body.mode === "plan" ? "plan" : "act";
  const id = typeof body.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : undefined;
  const session = await getKodeksDatabase().sessions.createSession({
    id,
    title,
    mode,
    workspaceRoot: getKodeksWorkspace().rootPath()
  });

  return Response.json({ session }, { status: 201 });
}
