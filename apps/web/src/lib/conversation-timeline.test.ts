import { describe, expect, it } from "vitest";

import {
  appendAssistantDelta,
  formatTimelinePayload,
  updateApprovalState,
  upsertRuntimeTimelineItem,
  type TimelineItem
} from "./conversation-timeline";

describe("conversation timeline", () => {
  it("appends assistant deltas into the active assistant item", () => {
    const items: TimelineItem[] = [{ type: "message", id: "a1", role: "assistant", content: "Hel" }];

    expect(appendAssistantDelta(items, "a1", "lo")).toEqual([
      { type: "message", id: "a1", role: "assistant", content: "Hello" }
    ]);
  });

  it("merges tool results into the matching tool call row", () => {
    const withCall = upsertRuntimeTimelineItem(
      [],
      { type: "tool_call", toolCallId: "tc1", toolName: "read_file", toolArguments: { path: "README.md" } },
      () => "id1"
    );
    const withResult = upsertRuntimeTimelineItem(
      withCall,
      { type: "tool_result", toolCallId: "tc1", toolName: "read_file", toolStatus: "ok", toolOutput: "done" },
      () => "id2"
    );

    expect(withResult).toEqual([
      {
        type: "tool",
        id: "tool-tc1",
        toolCallId: "tc1",
        name: "read_file",
        status: "completed",
        input: { path: "README.md" },
        output: "done"
      }
    ]);
  });

  it("tracks approval decisions in the visible conversation", () => {
    const items = upsertRuntimeTimelineItem(
      [],
      { type: "approval_required", approvalId: "ap1", toolCallId: "tc1", message: "run command" },
      () => "id1"
    );

    expect(updateApprovalState(items, "ap1", "approved")).toEqual([
      {
        type: "approval",
        id: "approval-ap1",
        approvalId: "ap1",
        toolCallId: "tc1",
        reason: "run command",
        state: "approved"
      }
    ]);
  });

  it("formats structured payloads for compact timeline cards", () => {
    expect(formatTimelinePayload({ ok: true })).toBe("{\n  \"ok\": true\n}");
    expect(formatTimelinePayload("plain")).toBe("plain");
  });
});
