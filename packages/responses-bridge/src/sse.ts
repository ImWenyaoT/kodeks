import type { DeepSeekStreamChunk, ResponsesStreamEvent } from "./types";

// 解析 OpenAI-compatible SSE，把每个 data JSON 转成 DeepSeek chunk。
export async function* parseDeepSeekSse(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<DeepSeekStreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice("data:".length).trim();
      if (data === "[DONE]") {
        return;
      }
      yield JSON.parse(data) as DeepSeekStreamChunk;
    }
  }
}

// 把 stream event 序列化成 OpenAI-compatible SSE frame。
export function toSseFrame(event: ResponsesStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
