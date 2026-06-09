import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getModels,
  requestJson,
  bridgePreflight,
  decideApproval,
} from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api client", () => {
  it("getModels filters to configured models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { ref: "a", configured: true, providerId: "p", modelName: "A" },
                { ref: "b", configured: false, providerId: "p", modelName: "B" },
              ],
              primary: "a",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const cat = await getModels();
    expect(cat.models.map((m) => m.ref)).toEqual(["a"]);
    expect(cat.primary).toBe("a");
  });

  it("requestJson throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(requestJson("/api/x")).rejects.toThrow();
  });

  it("bridgePreflight POSTs the model to /api/bridge/preflight", async () => {
    // 用 fetch mock 捕获请求的 url 与 init，断言方法、路径与 JSON body。
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await bridgePreflight("m");
    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/bridge/preflight");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ model: "m" }));
  });

  it("decideApproval POSTs the decision to /api/approvals/{id}", async () => {
    // 同样捕获 url 与 init，断言路径携带 id、body 绑定 decision 与 expectedCommandHash。
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ approval: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await decideApproval("a1", "approve", "hash-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/approvals/a1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ decision: "approve", expectedCommandHash: "hash-1" }),
    );
  });

  it("decideApproval omits the command hash for reject decisions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ approval: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await decideApproval("a1", "reject");
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.body).toBe(JSON.stringify({ decision: "reject" }));
  });
});
