import type { NextRequest } from "next/server";

import { inspectMoonBridgePreflight } from "@/lib/server/kodeks-runtime";

// Next.js API routes 需要 Node runtime 来读取本地 env 并探测 loopback bridge。
export const runtime = "nodejs";

// 返回当前 provider 的 MoonBridge 预检结果，供右侧调试面板首屏展示。
export async function POST(request: NextRequest): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return Response.json(await inspectMoonBridgePreflight(body));
}
