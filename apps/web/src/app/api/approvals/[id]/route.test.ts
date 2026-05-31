import { describe, expect, it } from "vitest";

import { parseApprovalDecision } from "./route";

describe("parseApprovalDecision", () => {
  it("accepts explicit approve and reject decisions", () => {
    expect(parseApprovalDecision("approve")).toBe("approve");
    expect(parseApprovalDecision("reject")).toBe("reject");
  });

  it("rejects missing or malformed decisions", () => {
    expect(parseApprovalDecision(undefined)).toBeNull();
    expect(parseApprovalDecision("Approve")).toBeNull();
    expect(parseApprovalDecision({ decision: "approve" })).toBeNull();
  });
});
