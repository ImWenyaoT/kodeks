// frontend/lib/events.test.ts
import { describe, it, expect } from "vitest";
import { parseRuntimeEvent } from "@/lib/events";

describe("parseRuntimeEvent", () => {
  it("parses text_delta", () => {
    const e = parseRuntimeEvent('{"type":"text_delta","delta":"hi"}');
    expect(e).toEqual({ type: "text_delta", delta: "hi" });
  });
  it("parses approval_required", () => {
    const e = parseRuntimeEvent(
      '{"type":"approval_required","approval_id":"a1","message":"run?","command":"rm -rf build","command_hash":"abc"}',
    );
    expect(e).toMatchObject({
      type: "approval_required",
      approvalId: "a1",
      message: "run?",
      command: "rm -rf build",
      commandHash: "abc",
    });
  });

  // tool_call：tool_call_id / tool_name 映射；缺省 tool_arguments 时 args 默认为 {}。
  it("parses tool_call and defaults args to {} when tool_arguments is absent", () => {
    const e = parseRuntimeEvent(
      '{"type":"tool_call","tool_call_id":"tc1","tool_name":"shell"}',
    );
    expect(e).toEqual({ type: "tool_call", toolCallId: "tc1", toolName: "shell", args: {} });
  });

  // tool_call：提供 tool_arguments 时透传为 args。
  it("parses tool_call and passes through tool_arguments as args", () => {
    const e = parseRuntimeEvent(
      '{"type":"tool_call","tool_call_id":"tc2","tool_name":"shell","tool_arguments":{"cmd":"ls"}}',
    );
    expect(e).toEqual({
      type: "tool_call",
      toolCallId: "tc2",
      toolName: "shell",
      args: { cmd: "ls" },
    });
  });

  // tool_result：output / status 由 tool_output / tool_status 映射。
  it("parses tool_result mapping output and status", () => {
    const e = parseRuntimeEvent(
      '{"type":"tool_result","tool_call_id":"tc1","tool_name":"shell","tool_output":"ok","tool_status":"success"}',
    );
    expect(e).toEqual({
      type: "tool_result",
      toolCallId: "tc1",
      toolName: "shell",
      output: "ok",
      status: "success",
    });
  });

  // error：带 code 时透传 code。
  it("parses error with a code", () => {
    const e = parseRuntimeEvent('{"type":"error","message":"boom","code":"E_BOOM"}');
    expect(e).toEqual({ type: "error", message: "boom", code: "E_BOOM" });
  });

  // error：缺省 code 时 code 为 undefined。
  it("parses error without a code (code undefined)", () => {
    const e = parseRuntimeEvent('{"type":"error","message":"boom"}');
    expect(e).toEqual({ type: "error", message: "boom", code: undefined });
  });

  // response_completed：response_id 映射为 responseId。
  it("parses response_completed mapping responseId", () => {
    const e = parseRuntimeEvent('{"type":"response_completed","response_id":"r1"}');
    expect(e).toEqual({ type: "response_completed", responseId: "r1" });
  });

  it("parses memory_recalled as a recognized passthrough variant", () => {
    const e = parseRuntimeEvent('{"type":"memory_recalled","x":1}');
    expect(e).not.toBeNull();
    expect(e!.type).toBe("memory_recalled");
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
