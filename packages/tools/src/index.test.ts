import { describe, expect, it } from "vitest";

import { packageName } from "./index";

describe("@kodeks/tools package boundary", () => {
  it("exports the package identity", () => {
    expect(packageName()).toBe("@kodeks/tools");
  });
});
