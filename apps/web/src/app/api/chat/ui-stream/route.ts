import { createKodeksUIMessageResponse } from '@/lib/server/kodeks-runtime';

// Next.js API routes 需要 Node runtime 以访问本地文件系统和 SQLite。
export const runtime = 'nodejs';

// 处理兼容 Vercel AI SDK UIMessage 的 chat streaming 请求。
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as unknown;
  return createKodeksUIMessageResponse(
    typeof body === 'object' && body !== null ? body : {},
    {
      signal: request.signal
    }
  );
}
