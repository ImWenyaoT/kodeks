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
});
