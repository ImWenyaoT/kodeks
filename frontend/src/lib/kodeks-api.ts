import { ChatMode, collectChatStream, type ChatStreamEvent } from "./chat-stream";

export type SendChatMessageInput = {
  input: string;
  sessionId: string;
  mode: ChatMode;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onEvent: (event: ChatStreamEvent) => void;
};

// Sends one chat turn through the Next.js proxy route and streams backend events.
export async function sendChatMessage({
  input,
  sessionId,
  mode,
  signal,
  onDelta,
  onEvent
}: SendChatMessageInput): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input,
      session_id: sessionId,
      mode
    }),
    signal
  });

  if (!response.ok || response.body === null) {
    throw new Error(`Chat request failed with HTTP ${response.status}.`);
  }

  await collectChatStream(response.body, {
    onDelta,
    onEvent
  });
}
