import { describe, it, expect } from "vitest";
import { extractSseData, readSse } from "@/lib/sse";

/**
 * 把字符串数组封装成一个 ReadableStream<Uint8Array>，模拟分块到达的 SSE 流。
 * 每个字符串作为一个 chunk 依次入队，入队完成后关闭流。
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

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

describe("readSse", () => {
  it("delivers each frame's payload, in order, for multiple frames in one chunk", async () => {
    // 单个 chunk 内包含两个完整帧（以 \n\n 分隔），应按顺序各回调一次。
    const got: string[] = [];
    await readSse(
      streamOf(["data: a\n\ndata: b\n\n"]),
      (d) => got.push(d),
    );
    expect(got).toEqual(["a", "b"]);
  });

  it("delivers a frame whose \\n\\n boundary is split across two chunks", async () => {
    // 帧边界的 \n\n 被拆到两个 chunk：第一个 chunk 以 ...\n 结尾，第二个以 \n 开头。
    const got: string[] = [];
    await readSse(
      streamOf(["data: hello\n", "\ndata: world\n\n"]),
      (d) => got.push(d),
    );
    expect(got).toEqual(["hello", "world"]);
  });

  it("flushes a trailing frame that has no terminating \\n\\n", async () => {
    // 最后一帧没有结尾的 \n\n，应在读取循环结束后被 flush 出来。
    const got: string[] = [];
    await readSse(
      streamOf(["data: a\n\ndata: tail"]),
      (d) => got.push(d),
    );
    expect(got).toEqual(["a", "tail"]);
  });

  it("skips a [DONE] frame", async () => {
    // [DONE] 帧不应触发 onData 回调。
    const got: string[] = [];
    await readSse(
      streamOf(["data: a\n\ndata: [DONE]\n\n"]),
      (d) => got.push(d),
    );
    expect(got).toEqual(["a"]);
  });
});
