import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inspectMoonBridgePreflight,
  listConfiguredModelCatalog,
  resetKodeksRuntimeForTest,
  resolveModelClientOptions,
  streamKodeksChat,
  toUiTransportPayload,
} from "./kodeks-runtime";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAIModel = process.env.OPENAI_MODEL;
const originalKodeksConfigPath = process.env.KODEKS_CONFIG_PATH;
const originalKodeksResponsesKey = process.env.KODEKS_RESPONSES_API_KEY;
const originalKodeksResponsesBaseUrl = process.env.KODEKS_RESPONSES_BASE_URL;
const originalKodeksResponsesModel = process.env.KODEKS_RESPONSES_MODEL;
const originalKodeksChatCompletionsKey =
  process.env.KODEKS_CHAT_COMPLETIONS_API_KEY;
const originalKodeksChatCompletionsBaseUrl =
  process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL;
const originalKodeksChatCompletionsModel =
  process.env.KODEKS_CHAT_COMPLETIONS_MODEL;
const originalKodeksModelProvider = process.env.KODEKS_MODEL_PROVIDER;
const originalBridgeEnabled = process.env.KODEKS_BRIDGE_ENABLED;
const originalBridgeKey = process.env.KODEKS_BRIDGE_API_KEY;
const originalBridgeBaseUrl = process.env.KODEKS_BRIDGE_BASE_URL;
const originalBridgeModel = process.env.KODEKS_BRIDGE_MODEL;
const originalBridgeReasoningEffort =
  process.env.KODEKS_BRIDGE_REASONING_EFFORT;
const originalBridgeDeepSeekKey = process.env.KODEKS_BRIDGE_DEEPSEEK_API_KEY;
const originalBridgeDeepSeekBaseUrl =
  process.env.KODEKS_BRIDGE_DEEPSEEK_BASE_URL;
const originalBridgeDeepSeekModel = process.env.KODEKS_BRIDGE_DEEPSEEK_MODEL;
const originalMoonBridgeEnabled = process.env.MOONBRIDGE_ENABLED;
const originalMoonBridgeKey = process.env.MOONBRIDGE_API_KEY;
const originalMoonBridgeBaseUrl = process.env.MOONBRIDGE_BASE_URL;
const originalMoonBridgeModel = process.env.MOONBRIDGE_MODEL;
const originalMoonBridgeReasoningEffort =
  process.env.MOONBRIDGE_REASONING_EFFORT;
const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const originalDeepSeekBaseUrl = process.env.DEEPSEEK_BASE_URL;
const originalDeepSeekModel = process.env.DEEPSEEK_MODEL;
const originalDeepSeekReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT;
const originalArkKey = process.env.ARK_API_KEY;
const originalArkBaseUrl = process.env.ARK_BASE_URL;
const originalArkModel = process.env.ARK_MODEL;
const originalDbPath = process.env.KODEKS_DB_PATH;
const originalWorkspaceRoot = process.env.KODEKS_WORKSPACE_ROOT;

beforeEach(() => {
  process.env.KODEKS_CONFIG_PATH = join(
    tmpdir(),
    "kodeks-test-missing-config.json",
  );
});

afterEach(async () => {
  await resetKodeksRuntimeForTest();
  restoreEnv("OPENAI_API_KEY", originalOpenAIKey);
  restoreEnv("OPENAI_BASE_URL", originalOpenAIBaseUrl);
  restoreEnv("OPENAI_MODEL", originalOpenAIModel);
  restoreEnv("KODEKS_CONFIG_PATH", originalKodeksConfigPath);
  restoreEnv("KODEKS_RESPONSES_API_KEY", originalKodeksResponsesKey);
  restoreEnv("KODEKS_RESPONSES_BASE_URL", originalKodeksResponsesBaseUrl);
  restoreEnv("KODEKS_RESPONSES_MODEL", originalKodeksResponsesModel);
  restoreEnv(
    "KODEKS_CHAT_COMPLETIONS_API_KEY",
    originalKodeksChatCompletionsKey,
  );
  restoreEnv(
    "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    originalKodeksChatCompletionsBaseUrl,
  );
  restoreEnv(
    "KODEKS_CHAT_COMPLETIONS_MODEL",
    originalKodeksChatCompletionsModel,
  );
  restoreEnv("KODEKS_MODEL_PROVIDER", originalKodeksModelProvider);
  restoreEnv("KODEKS_BRIDGE_ENABLED", originalBridgeEnabled);
  restoreEnv("KODEKS_BRIDGE_API_KEY", originalBridgeKey);
  restoreEnv("KODEKS_BRIDGE_BASE_URL", originalBridgeBaseUrl);
  restoreEnv("KODEKS_BRIDGE_MODEL", originalBridgeModel);
  restoreEnv("KODEKS_BRIDGE_REASONING_EFFORT", originalBridgeReasoningEffort);
  restoreEnv("KODEKS_BRIDGE_DEEPSEEK_API_KEY", originalBridgeDeepSeekKey);
  restoreEnv("KODEKS_BRIDGE_DEEPSEEK_BASE_URL", originalBridgeDeepSeekBaseUrl);
  restoreEnv("KODEKS_BRIDGE_DEEPSEEK_MODEL", originalBridgeDeepSeekModel);
  restoreEnv("MOONBRIDGE_ENABLED", originalMoonBridgeEnabled);
  restoreEnv("MOONBRIDGE_API_KEY", originalMoonBridgeKey);
  restoreEnv("MOONBRIDGE_BASE_URL", originalMoonBridgeBaseUrl);
  restoreEnv("MOONBRIDGE_MODEL", originalMoonBridgeModel);
  restoreEnv("MOONBRIDGE_REASONING_EFFORT", originalMoonBridgeReasoningEffort);
  restoreEnv("DEEPSEEK_API_KEY", originalDeepSeekKey);
  restoreEnv("DEEPSEEK_BASE_URL", originalDeepSeekBaseUrl);
  restoreEnv("DEEPSEEK_MODEL", originalDeepSeekModel);
  restoreEnv("DEEPSEEK_REASONING_EFFORT", originalDeepSeekReasoningEffort);
  restoreEnv("ARK_API_KEY", originalArkKey);
  restoreEnv("ARK_BASE_URL", originalArkBaseUrl);
  restoreEnv("ARK_MODEL", originalArkModel);
  restoreEnv("KODEKS_DB_PATH", originalDbPath);
  restoreEnv("KODEKS_WORKSPACE_ROOT", originalWorkspaceRoot);
});

// Restores a process env var without stringifying undefined into "undefined".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

// Clears model provider env so preflight tests do not inherit developer machine config.
function clearModelProviderEnv(): void {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.KODEKS_RESPONSES_API_KEY;
  delete process.env.KODEKS_RESPONSES_BASE_URL;
  delete process.env.KODEKS_RESPONSES_MODEL;
  delete process.env.KODEKS_CHAT_COMPLETIONS_API_KEY;
  delete process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL;
  delete process.env.KODEKS_CHAT_COMPLETIONS_MODEL;
  delete process.env.KODEKS_MODEL_PROVIDER;
  delete process.env.KODEKS_BRIDGE_ENABLED;
  delete process.env.KODEKS_BRIDGE_API_KEY;
  delete process.env.KODEKS_BRIDGE_BASE_URL;
  delete process.env.KODEKS_BRIDGE_MODEL;
  delete process.env.KODEKS_BRIDGE_REASONING_EFFORT;
  delete process.env.KODEKS_BRIDGE_DEEPSEEK_API_KEY;
  delete process.env.KODEKS_BRIDGE_DEEPSEEK_BASE_URL;
  delete process.env.KODEKS_BRIDGE_DEEPSEEK_MODEL;
  delete process.env.MOONBRIDGE_ENABLED;
  delete process.env.MOONBRIDGE_API_KEY;
  delete process.env.MOONBRIDGE_BASE_URL;
  delete process.env.MOONBRIDGE_MODEL;
  delete process.env.MOONBRIDGE_REASONING_EFFORT;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_REASONING_EFFORT;
  delete process.env.ARK_API_KEY;
  delete process.env.ARK_BASE_URL;
  delete process.env.ARK_MODEL;
}

describe("inspectMoonBridgePreflight", () => {
  it("lists DeepSeek as the frontend default model before configured models", () => {
    clearModelProviderEnv();

    expect(listConfiguredModelCatalog()).toMatchObject({
      primary: "deepseek/deepseek-v4-pro",
      models: [
        {
          ref: "deepseek/deepseek-v4-pro",
          providerId: "deepseek",
          providerName: "DeepSeek",
          modelId: "deepseek-v4-pro",
          api: "chat-completions",
          requiresBridge: true,
          baseURL: "https://api.deepseek.com",
        },
      ],
    });
  });

  it("marks direct Responses providers as not requiring MoonBridge", async () => {
    clearModelProviderEnv();
    process.env.KODEKS_RESPONSES_API_KEY = "responses-key";
    process.env.KODEKS_RESPONSES_MODEL = "responses-test";

    await expect(
      inspectMoonBridgePreflight({ provider: "openai" }),
    ).resolves.toMatchObject({
      status: "not_required",
      provider: "openai",
      resolvedProvider: "openai",
      bridgeModel: "responses-test",
    });
  });

  it("returns a specific unavailable reason when upstream config is missing", async () => {
    clearModelProviderEnv();

    await expect(
      inspectMoonBridgePreflight({ provider: "moonbridge" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      provider: "moonbridge",
      resolvedProvider: "moonbridge",
      code: "moonbridge_upstream_missing",
      reason: expect.stringContaining("KODEKS_CHAT_COMPLETIONS_API_KEY"),
    });
  });

  it("requires an api key for remote Chat Completions upstreams", async () => {
    clearModelProviderEnv();
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = "https://qwen.example/v1";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "qwen-coder";

    await expect(
      inspectMoonBridgePreflight({ provider: "moonbridge" }),
    ).resolves.toMatchObject({
      status: "unavailable",
      provider: "moonbridge",
      resolvedProvider: "moonbridge",
      code: "moonbridge_upstream_missing",
      reason: expect.stringContaining("KODEKS_CHAT_COMPLETIONS_API_KEY"),
    });
  });

  it("reports ready when provider config and local bridge health both pass", async () => {
    const healthyBridge = await startHealthyBridgeServer();
    clearModelProviderEnv();
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${readServerPort(healthyBridge)}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = "http://127.0.0.1:1234/v1";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "qwen-local";

    try {
      await expect(
        inspectMoonBridgePreflight({ provider: "moonbridge" }),
      ).resolves.toMatchObject({
        status: "ready",
        provider: "moonbridge",
        resolvedProvider: "moonbridge",
        bridgeBaseURL: process.env.KODEKS_BRIDGE_BASE_URL,
        upstreamBaseURL: "http://127.0.0.1:1234/v1",
        upstreamModel: "qwen-local",
      });
    } finally {
      await closeServer(healthyBridge);
    }
  });

  it("recovers to an available local port when the configured bridge port is occupied", async () => {
    const blockingServer = await startUnhealthyServer();
    const blockedPort = readServerPort(blockingServer);
    clearModelProviderEnv();
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${blockedPort}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = "http://127.0.0.1:1234/v1";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "qwen-local";

    try {
      const result = await inspectMoonBridgePreflight({
        provider: "moonbridge",
      });

      expect(result).toMatchObject({
        status: "ready",
        provider: "moonbridge",
        resolvedProvider: "moonbridge",
        code: "moonbridge_port_recovered",
        upstreamBaseURL: "http://127.0.0.1:1234/v1",
        upstreamModel: "qwen-local",
      });
      expect(result.bridgeBaseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(result.bridgeBaseURL).not.toBe(process.env.KODEKS_BRIDGE_BASE_URL);
      expect(result.reason).toContain(`http://127.0.0.1:${blockedPort}`);
      await expect(
        fetch(`${new URL(result.bridgeBaseURL!).origin}/health`),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await closeServer(blockingServer);
    }
  });
});

describe("streamKodeksChat", () => {
  it("stops before starting runtime work when the client request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = new Response(
      streamKodeksChat(
        { input: "hello", session_id: "s1" },
        { signal: controller.signal },
      ),
    );

    await expect(response.text()).resolves.toBe("");
  });

  it("auto-starts the local MoonBridge server for moonbridge turns", async () => {
    const deepSeekServer = await startFakeDeepSeekServer();
    const bridgePort = await getFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), "kodeks-moonbridge-"));
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, "kodeks.sqlite3");
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${bridgePort}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = `http://127.0.0.1:${readServerPort(deepSeekServer)}`;
    process.env.KODEKS_CHAT_COMPLETIONS_API_KEY = "chat-key";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "chat-test";

    try {
      const response = new Response(
        streamKodeksChat({
          input: "hello",
          mode: "act",
          provider: "moonbridge",
          reasoning_effort: "low",
        }),
      );

      await expect(response.text()).resolves.toContain(
        "Hello from managed MoonBridge",
      );
    } finally {
      await closeServer(deepSeekServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("continues MoonBridge tool calls through the local model-client loop", async () => {
    const deepSeekServer = await startFakeDeepSeekToolServer();
    const bridgePort = await getFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), "kodeks-moonbridge-tools-"));
    await writeFile(join(tempDir, "notes.txt"), "alpha\nbeta\n", "utf8");
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, "kodeks.sqlite3");
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${bridgePort}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = `http://127.0.0.1:${readServerPort(deepSeekServer)}`;
    process.env.KODEKS_CHAT_COMPLETIONS_API_KEY = "chat-key";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "chat-test";

    try {
      const response = new Response(
        streamKodeksChat({
          input: "show the notes file",
          mode: "act",
          provider: "moonbridge",
          reasoning_effort: "low",
        }),
      );
      const body = await response.text();

      expect(body).toContain("event: tool_call");
      expect(body).toContain("event: tool_result");
      expect(body).toContain("notes.txt contains alpha and beta");
      expect(body).not.toContain("Model did not produce a final response");
    } finally {
      await closeServer(deepSeekServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restarts managed MoonBridge when the upstream model config changes", async () => {
    const firstServer = await startFakeDeepSeekServer("Hello from first model");
    const secondServer = await startFakeDeepSeekServer(
      "Hello from second model",
    );
    const bridgePort = await getFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), "kodeks-moonbridge-switch-"));
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, "kodeks.sqlite3");
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${bridgePort}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_API_KEY = "chat-key";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "first-model";
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = `http://127.0.0.1:${readServerPort(firstServer)}`;

    try {
      const firstResponse = new Response(
        streamKodeksChat({
          input: "hello",
          mode: "act",
          provider: "moonbridge",
          reasoning_effort: "low",
        }),
      );
      await expect(firstResponse.text()).resolves.toContain(
        "Hello from first model",
      );

      process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "second-model";
      process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = `http://127.0.0.1:${readServerPort(secondServer)}`;

      const secondResponse = new Response(
        streamKodeksChat({
          input: "hello again",
          mode: "act",
          provider: "moonbridge",
          reasoning_effort: "low",
        }),
      );
      await expect(secondResponse.text()).resolves.toContain(
        "Hello from second model",
      );
    } finally {
      await closeServer(firstServer);
      await closeServer(secondServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("streams through a recovered MoonBridge port when the configured local port is occupied", async () => {
    const deepSeekServer = await startFakeDeepSeekServer();
    const blockingServer = await startUnhealthyServer();
    const blockedPort = readServerPort(blockingServer);
    const tempDir = await mkdtemp(join(tmpdir(), "kodeks-moonbridge-retry-"));
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, "kodeks.sqlite3");
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${blockedPort}/v1`;
    process.env.KODEKS_CHAT_COMPLETIONS_BASE_URL = `http://127.0.0.1:${readServerPort(deepSeekServer)}`;
    process.env.KODEKS_CHAT_COMPLETIONS_API_KEY = "chat-key";
    process.env.KODEKS_CHAT_COMPLETIONS_MODEL = "chat-test";

    try {
      const response = new Response(
        streamKodeksChat({
          input: "hello",
          mode: "act",
          provider: "moonbridge",
          reasoning_effort: "low",
        }),
      );
      const body = await response.text();

      expect(body).toContain("Hello from managed MoonBridge");
      expect(body).not.toContain("moonbridge_start_failed");
    } finally {
      await closeServer(blockingServer);
      await closeServer(deepSeekServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Starts a fake DeepSeek-compatible streaming endpoint for MoonBridge integration tests.
async function startFakeDeepSeekServer(
  text = "Hello from managed MoonBridge",
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl_moonbridge",
        choices: [{ delta: { content: text } }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl_moonbridge",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
  await listen(server, 0);
  return server;
}

// Starts a fake DeepSeek endpoint that requires one tool-result continuation.
async function startFakeDeepSeekToolServer(): Promise<Server> {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const payload = await readJsonRequest(request);
    requestCount += 1;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    if (requestCount === 1) {
      writeSse(response, {
        id: "chatcmpl_tool",
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read_notes",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"notes.txt"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    expect(JSON.stringify(payload)).toContain("call_read_notes");
    expect(JSON.stringify(payload)).toContain("alpha");
    writeSse(response, {
      id: "chatcmpl_final",
      choices: [{ delta: { content: "notes.txt contains alpha and beta." } }],
    });
    writeSse(response, {
      id: "chatcmpl_final",
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    response.write("data: [DONE]\n\n");
    response.end();
  });
  await listen(server, 0);
  return server;
}

// Starts a non-bridge loopback server so MoonBridge health checks fail before bind retry.
async function startUnhealthyServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end("not a bridge");
  });
  await listen(server, 0);
  return server;
}

// Reads a JSON request body from a mock DeepSeek endpoint.
async function readJsonRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

// Writes one Chat Completions SSE data frame.
function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Starts a healthy bridge-shaped server so preflight can verify /health cheaply.
async function startHealthyBridgeServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await listen(server, 0);
  return server;
}

// Allocates a loopback TCP port for a short-lived test server.
async function getFreePort(): Promise<number> {
  const server = createServer();
  await listen(server, 0);
  const port = readServerPort(server);
  await closeServer(server);
  return port;
}

// Waits for a Node HTTP server to start listening.
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
}

// Closes a Node HTTP server and resolves once all handles are released.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

// Reads the concrete port assigned to a listening test server.
function readServerPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

describe("resolveModelClientOptions", () => {
  it("prefers built-in bridge Responses configuration when enabled", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_BRIDGE_ENABLED: "true",
        KODEKS_BRIDGE_BASE_URL: "http://127.0.0.1:38440/v1/",
        KODEKS_BRIDGE_MODEL: "bridge",
        OPENAI_API_KEY: "openai-key",
      }),
    ).toEqual({
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
      provider: "moonbridge",
    });
  });

  it("rejects legacy bridge provider selection", () => {
    expect(() =>
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "bridge",
      }),
    ).toThrow('KODEKS_MODEL_PROVIDER="bridge" has been removed');
  });

  it("rejects MoonBridge environment compatibility aliases", () => {
    expect(() =>
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: "moonbridge",
        MOONBRIDGE_MODEL: "moonbridge",
      }),
    ).toThrow("MOONBRIDGE_MODEL has been removed");
  });

  it("lets a request-level provider override force MoonBridge", () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
          KODEKS_BRIDGE_MODEL: "moonbridge-session",
        },
        undefined,
        "moonbridge",
      ),
    ).toEqual({
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "moonbridge-session",
      reasoningEffort: "high",
      provider: "moonbridge",
    });
  });

  it("rejects request-level bridge override", () => {
    expect(() =>
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
          KODEKS_BRIDGE_MODEL: "bridge-session",
        },
        undefined,
        "bridge",
      ),
    ).toThrow('Model provider "bridge" has been removed');
  });

  it("rejects a legacy request-level DeepSeek override", () => {
    expect(() =>
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: "openai-key",
        },
        undefined,
        "deepseek",
      ),
    ).toThrow('Model provider "deepseek" has been removed');
  });

  it("prefers DeepSeek-first MoonBridge over OpenAI when both standard configs exist", () => {
    expect(
      resolveModelClientOptions({
        KODEKS_CHAT_COMPLETIONS_API_KEY: "deepseek-key",
        KODEKS_CHAT_COMPLETIONS_BASE_URL: "https://api.deepseek.com",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_MODEL: "gpt-test",
      }),
    ).toEqual({
      apiKey: "bridge",
      baseURL: "http://127.0.0.1:38440/v1",
      model: "bridge",
      reasoningEffort: "high",
      provider: "moonbridge",
    });
  });

  it("rejects legacy DeepSeek-only env", () => {
    expect(() =>
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: "deepseek-key",
      }),
    ).toThrow("DEEPSEEK_API_KEY has been removed");
  });

  it("accepts a valid request-level reasoning effort", () => {
    expect(
      resolveModelClientOptions(
        {
          KODEKS_CHAT_COMPLETIONS_API_KEY: "deepseek-key",
        },
        "xhigh",
      ),
    ).toMatchObject({
      reasoningEffort: "xhigh",
    });
  });

  it("falls back to OpenAI Responses when DeepSeek is not configured", () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_MODEL: "gpt-test",
      }),
    ).toEqual({
      apiKey: "openai-key",
      baseURL: "https://example.test/v1",
      model: "gpt-test",
      reasoningEffort: "medium",
      provider: "openai",
      statefulResponses: false,
      strictTools: false,
      hostedTools: [],
    });
  });

  it("returns null when no supported provider key is configured", () => {
    expect(resolveModelClientOptions({})).toBeNull();
  });
});

describe("toUiTransportPayload", () => {
  it("maps runtime events without changing the existing SSE contract", () => {
    expect(
      toUiTransportPayload({
        type: "text_delta",
        text: "Hello",
        sessionId: "s1",
      }),
    ).toEqual({
      type: "text-delta",
      delta: "Hello",
      sessionId: "s1",
    });
    expect(
      toUiTransportPayload({
        type: "tool_result",
        id: "call_1",
        name: "read_file",
        output: '{"ok":true}',
        status: "ok",
        sessionId: "s1",
      }),
    ).toEqual({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "read_file",
      result: '{"ok":true}',
      status: "ok",
      sessionId: "s1",
    });
    expect(
      toUiTransportPayload({
        type: "response_completed",
        responseId: "resp_1",
        sessionId: "s1",
      }),
    ).toEqual({
      type: "finish",
      responseId: "resp_1",
      sessionId: "s1",
    });
  });
});
