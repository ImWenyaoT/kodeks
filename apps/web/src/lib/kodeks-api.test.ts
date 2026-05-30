import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMoonBridgePreflight, sendChatMessage } from "./kodeks-api";

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
      },
    }),
    { status: 200 },
  );
}

describe("sendChatMessage", () => {
  it("sends the selected model as a per-session route parameter", async () => {
    const fetchMock = vi.fn(async () => createEmptyStreamResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await sendChatMessage({
      input: "hello",
      sessionId: "session_1",
      mode: "act",
      model: "qwen/qwen3.6",
      reasoningEffort: "high",
      onDelta: vi.fn(),
      onEvent: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          input: "hello",
          session_id: "session_1",
          mode: "act",
          model: "qwen/qwen3.6",
          reasoning_effort: "high",
        }),
      }),
    );
  });

  it("sends selected workspace files when the user attaches local context", async () => {
    const fetchMock = vi.fn(async () => createEmptyStreamResponse());
    globalThis.fetch = fetchMock as typeof fetch;

    await sendChatMessage({
      input: "inspect these",
      mode: "act",
      model: "qwen/qwen3.6",
      reasoningEffort: "medium",
      selectedFiles: ["apps/web/src/components/tools-panel.tsx"],
      onDelta: vi.fn(),
      onEvent: vi.fn(),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          input: "inspect these",
          mode: "act",
          model: "qwen/qwen3.6",
          reasoning_effort: "medium",
          selected_files: ["apps/web/src/components/tools-panel.tsx"],
        }),
      }),
    );
  });
});

describe("fetchMoonBridgePreflight", () => {
  it("sends the selected model to the preflight route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "ready",
            provider: "moonbridge",
            checkedAt: "2026-05-29T00:00:00.000Z",
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      fetchMoonBridgePreflight("qwen/qwen3.6"),
    ).resolves.toMatchObject({
      status: "ready",
      provider: "moonbridge",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridge/preflight",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "qwen/qwen3.6" }),
      }),
    );
  });

  it("can preflight env-only provider config without a selected model", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "not_required",
            provider: "auto",
            checkedAt: "2026-05-29T00:00:00.000Z",
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchMoonBridgePreflight()).resolves.toMatchObject({
      status: "not_required",
      provider: "auto",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bridge/preflight",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  it("throws when the preflight route fails", async () => {
    const fetchMock = vi.fn(async () => new Response("oops", { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchMoonBridgePreflight("moonbridge")).rejects.toThrow(
      "MoonBridge preflight failed with HTTP 500.",
    );
  });
});
