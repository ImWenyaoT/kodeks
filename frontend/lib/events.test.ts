// frontend/lib/events.test.ts
import { describe, it, expect } from "vitest";
import { parseRuntimeEvent } from "@/lib/events";

describe("parseRuntimeEvent", () => {
  it("parses text_delta", () => {
    const e = parseRuntimeEvent('{"type":"text_delta","delta":"hi"}');
    expect(e).toEqual({ type: "text_delta", delta: "hi" });
  });
  it("parses approval_required", () => {
    const e = parseRuntimeEvent('{"type":"approval_required","approval_id":"a1","message":"run?"}');
    expect(e).toMatchObject({ type: "approval_required", approvalId: "a1", message: "run?" });
  });
  it("falls back to unknown for unrecognized type", () => {
    const e = parseRuntimeEvent('{"type":"memory_recalled","x":1}');
    expect(e.type).toBe("memory_recalled");
  });
  it("returns null for invalid JSON", () => {
    expect(parseRuntimeEvent("{not json")).toBeNull();
  });
  // 验证 default 分支：真正未识别的 type 会落入 unknown 兜底
  it("maps an unrecognized type to the unknown fallback", () => {
    const e = parseRuntimeEvent('{"type":"some_future_event","x":1}');
    expect(e).toEqual({ type: "unknown", name: "some_future_event", raw: { type: "some_future_event", x: 1 } });
  });
});
