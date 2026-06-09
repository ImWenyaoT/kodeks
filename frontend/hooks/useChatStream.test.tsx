// frontend/hooks/useChatStream.test.tsx
// useChatStream 的单元测试：用 mock 的 openChatStream 喂入假 SSE 流，
// 验证一个完整 turn 的副作用（流式 delta 落到助手气泡、session_created 写回 sessionId、
// 以及 stop 会传入可中断的 AbortSignal）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { useChatStore } from "@/stores/chat-store";
import { I18nProvider } from "@/components/providers/I18nProvider";

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

// useChatStream 现会读取 useI18n（用于本地化运行失败提示），故必须在 I18nProvider
// 内渲染；renderHook 通过 wrapper 提供 Provider 上下文。
function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
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

    const { result } = renderHook(() => useChatStream(), { wrapper });
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

  it("pushes an approval when an approval_required frame arrives", async () => {
    const body = streamFrom([
      'event: approval_required\ndata: {"type":"approval_required","approval_id":"ap-9","tool_call_id":"tc-9","message":"Run `rm -rf build`?","command":"rm -rf build","command_hash":"hash-9"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream(), { wrapper });
    await act(async () => {
      await result.current.send("hi");
    });

    // approval_required 帧应被分派到 pushApproval，落入 store.approvals。
    expect(useChatStore.getState().approvals).toEqual([
      {
        approvalId: "ap-9",
        message: "Run `rm -rf build`?",
        command: "rm -rf build",
        commandHash: "hash-9",
      },
    ]);
    expect(useChatStore.getState().isRunning).toBe(false);
  });

  it("renders localized runtime-failure text and pushes a runtime event on an error frame", async () => {
    const body = streamFrom([
      'event: error\ndata: {"type":"error","message":"boom","code":"E_BOOM"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream(), { wrapper });
    await act(async () => {
      await result.current.send("hi");
    });

    // jsdom 默认语言为 en，故助手气泡应含英文版 runtimeFailed 文案（来自 t.runtimeFailed）。
    const messages = useChatStore.getState().messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.text).toContain("Runtime failed: boom");
    // error 帧携带 code，运行事件流应推入该 code。
    expect(useChatStore.getState().runtimeEvents).toContain("E_BOOM");
    expect(useChatStore.getState().isRunning).toBe(false);
  });

  it("pushes a runtime marker for tool_call (default-branch) frames", async () => {
    const body = streamFrom([
      'event: tool_call\ndata: {"type":"tool_call","tool_call_id":"tc-1","tool_name":"shell"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream(), { wrapper });
    await act(async () => {
      await result.current.send("hi");
    });

    // tool_call 走 default 分支，用 type 作为紧凑运行事件标记。
    expect(useChatStore.getState().runtimeEvents).toContain("tool_call");
    expect(useChatStore.getState().isRunning).toBe(false);
  });

  it("handles a non-2xx response without throwing and surfaces a runtime error", async () => {
    // res.ok=false：send() 内部抛出 "chat failed with HTTP ..." 并被 catch 接住。
    vi.mocked(openChatStream).mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    const { result } = renderHook(() => useChatStream(), { wrapper });
    // 不应有异常逃逸出 send()。
    await act(async () => {
      await expect(result.current.send("hi")).resolves.toBeUndefined();
    });

    // catch 分支推一条通用 "error" 运行事件，并把本地化失败文案落到助手气泡。
    expect(useChatStore.getState().runtimeEvents).toContain("error");
    const messages = useChatStore.getState().messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.text).toContain("Runtime failed:");
    expect(lastAssistant?.text).toContain("chat failed with HTTP 500");
    // 运行态复位（finally 分支）。
    expect(useChatStore.getState().isRunning).toBe(false);
  });

  it("passes an AbortSignal to openChatStream so stop() can abort", async () => {
    const body = streamFrom([
      'event: text_delta\ndata: {"type":"text_delta","delta":"x"}\n\n',
    ]);
    vi.mocked(openChatStream).mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    const { result } = renderHook(() => useChatStream(), { wrapper });
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
