import { NextRequest } from "next/server";

import { getKodeksDatabase, getKodeksWorkspace } from "@/lib/server/kodeks-runtime";

export const runtime = "nodejs";

// Lists known sessions for the local kodeks workspace.
export async function GET(): Promise<Response> {
  const sessions = await getKodeksDatabase().sessions.listSessions();
  return Response.json({ sessions });
}

// Creates one session record for resume and explicit mode tracking.
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
