import { collectChatStream, type ChatStreamEvent } from './chat-stream';
import type { ChatMode } from './chat-stream';
import type { ModelProviderOverride } from '@kodeks/model';

export type SendChatMessageInput = {
  input: string;
  sessionId?: string;
  mode: ChatMode;
  provider: ModelProviderOverride;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  selectedFiles?: string[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onEvent: (event: ChatStreamEvent) => void;
};

// Sends one chat turn through the Next.js proxy route and streams backend events.
export async function sendChatMessage({
  input,
  sessionId,
  mode,
  provider,
  reasoningEffort,
  selectedFiles = [],
  signal,
  onDelta,
  onEvent
}: SendChatMessageInput): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      mode,
      provider,
      reasoning_effort: reasoningEffort,
      ...(selectedFiles.length === 0 ? {} : { selected_files: selectedFiles })
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
