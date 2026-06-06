// frontend/hooks/useChatStream.test.tsx
// useChatStream 的单元测试：用 mock 的 openChatStream 喂入假 SSE 流，
// 验证一个完整 turn 的副作用（流式 delta 落到助手气泡、session_created 写回 sessionId、
// 以及 stop 会传入可中断的 AbortSignal）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatStore } from "@/stores/chat-store";

// 对 API 模块做 mock：仅替换 openChatStream，其余导出保持真实实现。
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, openChatStream: vi.fn() };
});

import { openChatStream } from "@/lib/api";
import { useChatStream } from "@/hooks/useChatStream";

/**
 * 用一组 SSE 帧文本构造一个可读字节流，模拟后端 Response.body。
 * 每个 frame 以 "\n\n" 结尾，readSse 会据此切分。
 */
function streamFrom(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

beforeEach(() => {
  // 每个测试前重置 store 运行态，并设置一个合法 model 以保证请求体有效。
  useChatStore.getState().reset();
  useChatStore.getState().setSettings({ model: "test-model" });
  vi.mocked(openChatStream).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatStream", () => {
  it("streams text_delta into the assistant bubble and writes session_created", async () => {
    const body = streamFrom([
      'event: session_created\ndata: {"type":"session_created","session_id":"s_test"}\n\n',
      'event: text_delta\ndata: {"type":"text_delta","delta":"hello"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("hi");
    });

    const messages = useChatStore.getState().messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.text).toBe("hello");
    expect(useChatStore.getState().sessionId).toBe("s_test");
    expect(useChatStore.getState().isRunning).toBe(false);
  });

  it("passes an AbortSignal to openChatStream so stop() can abort", async () => {
    const body = streamFrom([
      'event: text_delta\ndata: {"type":"text_delta","delta":"x"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send("hi");
    });

    expect(openChatStream).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(openChatStream).mock.calls[0][1];
    expect(signal).toBeInstanceOf(AbortSignal);

    // stop() 不应抛错，且会把 isRunning 复位。
    act(() => {
      result.current.stop();
    });
    expect(useChatStore.getState().isRunning).toBe(false);
  });
});
