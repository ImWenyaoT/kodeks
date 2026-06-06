import { describe, it, expect } from "vitest";
import { extractSseData } from "@/lib/sse";

describe("extractSseData", () => {
  it("returns the payload from a single data line (with space)", () => {
    expect(extractSseData("event: text_delta\ndata: {\"type\":\"text_delta\"}"))
      .toBe('{"type":"text_delta"}');
  });
  it("handles 'data:' without a trailing space", () => {
    expect(extractSseData("data:{\"a\":1}")).toBe('{"a":1}');
  });
  it("joins multiple data lines with newline", () => {
    expect(extractSseData("data: a\ndata: b")).toBe("a\nb");
  });
  it("ignores non-data lines", () => {
    expect(extractSseData("event: ping\nid: 1\ndata: x")).toBe("x");
  });
  it("returns null for [DONE]", () => {
    expect(extractSseData("data: [DONE]")).toBeNull();
  });
  it("returns null for an empty/no-data frame", () => {
    expect(extractSseData("event: ping")).toBeNull();
    expect(extractSseData("")).toBeNull();
  });
});
