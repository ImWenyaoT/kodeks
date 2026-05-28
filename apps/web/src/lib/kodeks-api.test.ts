import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendChatMessage } from './kodeks-api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// Creates an empty successful fetch response so sendChatMessage can finish stream parsing.
function createEmptyStreamResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    }),
    { status: 200 }
  );
}

describe('sendChatMessage', () => {
  it('sends the selected provider as a per-session route parameter', async () => {
    const fetchMock = vi.fn(async () => createEmptyStreamResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await sendChatMessage({
      input: 'hello',
      sessionId: 'session_1',
      mode: 'act',
      provider: 'deepseek',
      reasoningEffort: 'high',
      onDelta: vi.fn(),
      onEvent: vi.fn()
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat/stream',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          input: 'hello',
          session_id: 'session_1',
          mode: 'act',
          provider: 'deepseek',
          reasoning_effort: 'high'
        })
      })
    );
  });
});
