import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@kodeks/agent-runtime package boundary", () => {
  it("exports the package identity", () => {
    expect(packageName()).toBe("@kodeks/agent-runtime");
  });
});
