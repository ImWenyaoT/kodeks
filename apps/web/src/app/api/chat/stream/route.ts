import { NextRequest } from "next/server";

const BACKEND_BASE_URL = process.env.KODEKS_API_BASE_URL ?? "http://127.0.0.1:8000";

// Proxies the browser chat request to FastAPI so the UI avoids CORS issues.
export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.text();

  const backendResponse = await fetch(`${BACKEND_BASE_URL}/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body
  });

  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: {
      "Content-Type": backendResponse.headers.get("Content-Type") ?? "text/event-stream"
    }
  });
}
