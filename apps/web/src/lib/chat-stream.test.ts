import { describe, expect, it } from "vitest";

import { collectChatStream, parseSseFrames } from "./chat-stream";

describe("parseSseFrames", () => {
  it("parses text deltas and completion ids from FastAPI SSE frames", () => {
    const frames = [
      'event: text_delta\ndata: {"type":"text_delta","delta":"Hel","session_id":"s1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"lo","session_id":"s1"}\n\n',
      'event: response_completed\ndata: {"type":"response_completed","response_id":"resp_1","session_id":"s1"}\n\n'
    ];

    expect(parseSseFrames(frames.join(""))).toEqual([
      { type: "text_delta", delta: "Hel", sessionId: "s1" },
      { type: "text_delta", delta: "lo", sessionId: "s1" },
      { type: "response_completed", responseId: "resp_1", sessionId: "s1" }
    ]);
  });
});

describe("collectChatStream", () => {
  it("streams decoded assistant text in arrival order", async () => {
    const chunks = [
      'event: text_delta\ndata: {"type":"text_delta","delta":"A","session_id":"s1"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"B","session_id":"s1"}\n\n'
    ];
    const received: string[] = [];

    await collectChatStream(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        }
      }),
      {
        onDelta(delta) {
          received.push(delta);
        }
      }
    );

    expect(received).toEqual(["A", "B"]);
  });
});
