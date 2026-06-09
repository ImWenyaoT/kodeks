// frontend/lib/events.ts
export type RuntimeEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "text_delta"; delta: string }
  | { type: "assistant_status"; message: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_result"; toolCallId: string; toolName: string; output: string; status: string }
  | {
      type: "approval_required";
      approvalId: string;
      toolCallId: string;
      message: string;
      command: string;
      commandHash: string;
    }
  | { type: "plan_artifact"; raw: Record<string, unknown> }
  | { type: "memory_recalled"; raw: Record<string, unknown> }
  | { type: "response_completed"; responseId: string }
  | { type: "error"; message: string; code?: string }
  | { type: "unknown"; name: string; raw: Record<string, unknown> };

const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Narrow a raw backend SSE data string into a typed RuntimeEvent. */
export function parseRuntimeEvent(data: string): RuntimeEvent | null {
  let r: Record<string, unknown>;
  try { r = JSON.parse(data); } catch { return null; }
  switch (r.type) {
    case "session_created": return { type: "session_created", sessionId: s(r.session_id) };
    case "text_delta": return { type: "text_delta", delta: s(r.delta) };
    case "assistant_status": return { type: "assistant_status", message: s(r.message) };
    case "tool_call":
      return { type: "tool_call", toolCallId: s(r.tool_call_id), toolName: s(r.tool_name), args: r.tool_arguments ?? {} };
    case "tool_result":
      return { type: "tool_result", toolCallId: s(r.tool_call_id), toolName: s(r.tool_name), output: s(r.tool_output), status: s(r.tool_status) };
    case "approval_required":
      return {
        type: "approval_required",
        approvalId: s(r.approval_id),
        toolCallId: s(r.tool_call_id),
        message: s(r.message),
        command: s(r.command),
        commandHash: s(r.command_hash),
      };
    case "plan_artifact": return { type: "plan_artifact", raw: r };
    case "memory_recalled": return { type: "memory_recalled", raw: r };
    case "response_completed": return { type: "response_completed", responseId: s(r.response_id) };
    case "error": return { type: "error", message: s(r.message), code: typeof r.code === "string" ? r.code : undefined };
    default: return { type: "unknown", name: s(r.type), raw: r };
  }
}
