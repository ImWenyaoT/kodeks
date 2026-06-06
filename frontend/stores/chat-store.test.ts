// frontend/stores/chat-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "@/stores/chat-store";

// 每个用例前重置整个 store（含 settings），保证测试相互隔离。
// 先调用 reset() 清空运行态，再显式还原 settings 为默认值。
beforeEach(() => {
  useChatStore.getState().reset();
  useChatStore.getState().setSettings({
    mode: "act",
    model: "",
    providerId: "",
    reasoning: "medium",
  });
});

describe("chat-store", () => {
  // 用例 1：appendMessage 返回新消息 id，appendDelta 按 id 累积流式文本。
  it("appendMessage + appendDelta accumulate streaming text", () => {
    const id = useChatStore.getState().appendMessage("assistant", "");
    expect(typeof id).toBe("string");

    useChatStore.getState().appendDelta(id, "he");
    useChatStore.getState().appendDelta(id, "llo");

    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg).toBeDefined();
    expect(msg!.text).toBe("hello");
    expect(msg!.role).toBe("assistant");
  });

  // appendMessage 应生成互不相同的 id，便于多气泡寻址。
  it("appendMessage returns unique ids", () => {
    const a = useChatStore.getState().appendMessage("user", "hi");
    const b = useChatStore.getState().appendMessage("assistant", "yo");
    expect(a).not.toBe(b);
    expect(useChatStore.getState().messages).toHaveLength(2);
  });

  // 用例 2：toggleFile 添加/移除路径，且每次都会生成全新的 Set 引用。
  it("toggleFile adds then removes a path and replaces the Set reference", () => {
    const before = useChatStore.getState().selectedFiles;
    expect(before.has("a.ts")).toBe(false);

    useChatStore.getState().toggleFile("a.ts");
    const afterAdd = useChatStore.getState().selectedFiles;
    expect(afterAdd.has("a.ts")).toBe(true);
    // 不可变更新：引用必须改变，订阅者才会重新渲染。
    expect(afterAdd).not.toBe(before);

    useChatStore.getState().toggleFile("a.ts");
    const afterRemove = useChatStore.getState().selectedFiles;
    expect(afterRemove.has("a.ts")).toBe(false);
    expect(afterRemove).not.toBe(afterAdd);
  });

  // 用例 3：reset 清空 messages/sessionId 等运行态，但保留已改动的 settings。
  it("reset clears runtime state but keeps settings", () => {
    useChatStore.getState().appendMessage("user", "hello");
    useChatStore.getState().setSession("sess-1");
    useChatStore.getState().setSettings({ mode: "plan" });

    useChatStore.getState().reset();

    const s = useChatStore.getState();
    expect(s.messages).toHaveLength(0);
    expect(s.sessionId).toBe("");
    // 关键：settings 不被 reset 影响。
    expect(s.mode).toBe("plan");
  });

  // reset 同时应清空 selectedFiles、runtimeEvents、approvals、isRunning。
  it("reset clears selectedFiles, runtimeEvents, approvals and isRunning", () => {
    useChatStore.getState().toggleFile("x.ts");
    useChatStore.getState().pushRuntime("evt");
    useChatStore.getState().pushApproval({ approvalId: "ap1", message: "ok?" });
    useChatStore.getState().setRunning(true);

    useChatStore.getState().reset();

    const s = useChatStore.getState();
    expect(s.selectedFiles.size).toBe(0);
    expect(s.runtimeEvents).toHaveLength(0);
    expect(s.approvals).toHaveLength(0);
    expect(s.isRunning).toBe(false);
  });

  // setSettings 应做浅合并，未提供的字段保持不变。
  it("setSettings shallow-merges and leaves other fields intact", () => {
    useChatStore.getState().setSettings({ model: "gpt", providerId: "openai" });
    let s = useChatStore.getState();
    expect(s.model).toBe("gpt");
    expect(s.providerId).toBe("openai");
    expect(s.mode).toBe("act");

    useChatStore.getState().setSettings({ reasoning: "high" });
    s = useChatStore.getState();
    expect(s.reasoning).toBe("high");
    // 之前设置的 model/providerId 不应被覆盖。
    expect(s.model).toBe("gpt");
    expect(s.providerId).toBe("openai");
  });

  // pushRuntime 采用追加语义（append，最旧在前，最新在后）。
  it("pushRuntime appends runtime-event strings in order", () => {
    useChatStore.getState().pushRuntime("first");
    useChatStore.getState().pushRuntime("second");
    expect(useChatStore.getState().runtimeEvents).toEqual(["first", "second"]);
  });

  // pushApproval 追加待审批项。
  it("pushApproval appends approvals", () => {
    useChatStore.getState().pushApproval({ approvalId: "a1", message: "run cmd?" });
    expect(useChatStore.getState().approvals).toEqual([
      { approvalId: "a1", message: "run cmd?" },
    ]);
  });

  // setRunning / setSession 基本读写。
  it("setRunning and setSession update primitive state", () => {
    useChatStore.getState().setRunning(true);
    expect(useChatStore.getState().isRunning).toBe(true);
    useChatStore.getState().setSession("abc");
    expect(useChatStore.getState().sessionId).toBe("abc");
  });

  // appendDelta 对不存在的 id 应为无操作（不抛错、不新增消息）。
  it("appendDelta is a no-op for an unknown id", () => {
    const id = useChatStore.getState().appendMessage("assistant", "x");
    useChatStore.getState().appendDelta("does-not-exist", "y");
    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg!.text).toBe("x");
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});
