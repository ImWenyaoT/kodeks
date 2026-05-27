import { createKodeksUIMessageResponse } from "@/lib/server/kodeks-runtime";

// Next.js 的 nodejs runtime 标签和 Bun 包管理/启动方式不冲突；本地仍通过 bun --bun next 运行。
export const runtime = "nodejs";

// 处理兼容 Vercel AI SDK UIMessage 的 chat streaming 请求。
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as unknown;
  return createKodeksUIMessageResponse(typeof body === "object" && body !== null ? body : {}, {
    signal: request.signal
  });
}
