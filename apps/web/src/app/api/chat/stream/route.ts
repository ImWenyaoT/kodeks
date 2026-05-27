import { NextRequest } from "next/server";

import { streamKodeksChat } from "@/lib/server/kodeks-runtime";

// Next.js 的 nodejs runtime 标签和 Bun 包管理/启动方式不冲突；本地仍通过 bun --bun next 运行。
export const runtime = "nodejs";

// 把一次 chat 请求接入 TypeScript Kodeks runtime，并返回 SSE stream。
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  return new Response(streamKodeksChat(body, { signal: request.signal }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}
