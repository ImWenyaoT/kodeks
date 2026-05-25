import { NextRequest } from "next/server";

import { streamKodeksChat } from "@/lib/server/kodeks-runtime";

export const runtime = "nodejs";

// Streams one chat request through the TypeScript kodeks runtime.
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  return new Response(streamKodeksChat(body, { signal: request.signal }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}
