import { createKodeksUIMessageResponse } from "@/lib/server/kodeks-runtime";

export const runtime = "nodejs";

// Handles Vercel AI SDK UIMessage-compatible chat streaming.
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as unknown;
  return createKodeksUIMessageResponse(typeof body === "object" && body !== null ? body : {});
}
