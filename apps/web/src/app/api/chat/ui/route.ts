import type { NextRequest } from "next/server";

import { streamKodeksChatUiTransport } from "@/lib/server/kodeks-runtime";

// Next.js API routes need Node runtime for the shared local Kodeks services.
export const runtime = "nodejs";

// Adapts the same AgentEvent runtime stream into an experimental UI transport.
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return new Response(
    streamKodeksChatUiTransport(body, { signal: request.signal }),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    },
  );
}
