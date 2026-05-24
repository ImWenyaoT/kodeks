import { afterEach, describe, expect, it } from "vitest";

import { createKodeksUIMessageResponse } from "./kodeks-runtime";

const originalOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  process.env.OPENAI_API_KEY = originalOpenAIKey;
});

describe("createKodeksUIMessageResponse", () => {
  it("returns a Vercel AI SDK UIMessage stream response for runtime errors", async () => {
    delete process.env.OPENAI_API_KEY;

    const response = createKodeksUIMessageResponse({ input: "hello", session_id: "s1" });
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("OPENAI_API_KEY is required");
  });
});
