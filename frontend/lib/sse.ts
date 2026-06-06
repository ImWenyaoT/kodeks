/** Extract the joined `data:` payload from one SSE frame, or null for empty/[DONE]. */
export function extractSseData(frame: string): string | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return data;
}

/** Read an SSE stream, invoking onData with each complete frame's JSON payload string. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let i = buffer.indexOf("\n\n");
    while (i !== -1) {
      const data = extractSseData(buffer.slice(0, i));
      buffer = buffer.slice(i + 2);
      if (data) onData(data);
      i = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  const tail = extractSseData(buffer);
  if (tail) onData(tail);
}
