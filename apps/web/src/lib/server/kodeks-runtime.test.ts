import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createKodeksUIMessageResponse,
  resolveModelClientOptions,
  streamKodeksChat
} from './kodeks-runtime';

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;
const originalOpenAIModel = process.env.OPENAI_MODEL;
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

afterEach(() => {
  restoreEnv('OPENAI_API_KEY', originalOpenAIKey);
  restoreEnv('OPENAI_BASE_URL', originalOpenAIBaseUrl);
  restoreEnv('OPENAI_MODEL', originalOpenAIModel);
  restoreEnv('KODEKS_MODEL_PROVIDER', originalKodeksModelProvider);
  restoreEnv('KODEKS_BRIDGE_ENABLED', originalBridgeEnabled);
  restoreEnv('KODEKS_BRIDGE_API_KEY', originalBridgeKey);
  restoreEnv('KODEKS_BRIDGE_BASE_URL', originalBridgeBaseUrl);
  restoreEnv('KODEKS_BRIDGE_MODEL', originalBridgeModel);
  restoreEnv('KODEKS_BRIDGE_REASONING_EFFORT', originalBridgeReasoningEffort);
  restoreEnv('KODEKS_BRIDGE_DEEPSEEK_API_KEY', originalBridgeDeepSeekKey);
  restoreEnv(
    'KODEKS_BRIDGE_DEEPSEEK_BASE_URL',
    originalBridgeDeepSeekBaseUrl
  );
  restoreEnv('KODEKS_BRIDGE_DEEPSEEK_MODEL', originalBridgeDeepSeekModel);
  restoreEnv('MOONBRIDGE_ENABLED', originalMoonBridgeEnabled);
  restoreEnv('MOONBRIDGE_API_KEY', originalMoonBridgeKey);
  restoreEnv('MOONBRIDGE_BASE_URL', originalMoonBridgeBaseUrl);
  restoreEnv('MOONBRIDGE_MODEL', originalMoonBridgeModel);
  restoreEnv('MOONBRIDGE_REASONING_EFFORT', originalMoonBridgeReasoningEffort);
  restoreEnv('DEEPSEEK_API_KEY', originalDeepSeekKey);
  restoreEnv('DEEPSEEK_BASE_URL', originalDeepSeekBaseUrl);
  restoreEnv('DEEPSEEK_MODEL', originalDeepSeekModel);
  restoreEnv('DEEPSEEK_REASONING_EFFORT', originalDeepSeekReasoningEffort);
  restoreEnv('ARK_API_KEY', originalArkKey);
  restoreEnv('ARK_BASE_URL', originalArkBaseUrl);
  restoreEnv('ARK_MODEL', originalArkModel);
  restoreEnv('KODEKS_DB_PATH', originalDbPath);
  restoreEnv('KODEKS_WORKSPACE_ROOT', originalWorkspaceRoot);
});

// Restores a process env var without stringifying undefined into "undefined".
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe('createKodeksUIMessageResponse', () => {
  it('returns a Vercel AI SDK UIMessage stream response for runtime errors', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.KODEKS_MODEL_PROVIDER;
    delete process.env.KODEKS_BRIDGE_ENABLED;
    delete process.env.KODEKS_BRIDGE_BASE_URL;
    delete process.env.MOONBRIDGE_ENABLED;
    delete process.env.MOONBRIDGE_BASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.ARK_API_KEY;

    const response = createKodeksUIMessageResponse({
      input: 'hello',
      session_id: 's1'
    });
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('data-error');
    expect(body).toContain('model_provider_missing');
    expect(body).toContain('Set OPENAI_API_KEY');
  });
});

describe('streamKodeksChat', () => {
  it('stops before starting runtime work when the client request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const response = new Response(
      streamKodeksChat(
        { input: 'hello', session_id: 's1' },
        { signal: controller.signal }
      )
    );

    await expect(response.text()).resolves.toBe('');
  });

  it('auto-starts the local MoonBridge server for moonbridge turns', async () => {
    const deepSeekServer = await startFakeDeepSeekServer();
    const bridgePort = await getFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), 'kodeks-moonbridge-'));
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, 'kodeks.sqlite3');
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${bridgePort}/v1`;
    process.env.KODEKS_BRIDGE_DEEPSEEK_BASE_URL = `http://127.0.0.1:${readServerPort(deepSeekServer)}`;
    process.env.KODEKS_BRIDGE_DEEPSEEK_API_KEY = 'deepseek-key';
    process.env.KODEKS_BRIDGE_DEEPSEEK_MODEL = 'deepseek-test';

    try {
      const response = new Response(
        streamKodeksChat({
          input: 'hello',
          mode: 'act',
          provider: 'moonbridge',
          reasoning_effort: 'low'
        })
      );

      await expect(response.text()).resolves.toContain(
        'Hello from managed MoonBridge'
      );
    } finally {
      await closeServer(deepSeekServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('streams a visible error when MoonBridge cannot bind its local port', async () => {
    const blockingServer = await startUnhealthyServer();
    const blockedPort = readServerPort(blockingServer);
    const tempDir = await mkdtemp(join(tmpdir(), 'kodeks-moonbridge-error-'));
    process.env.KODEKS_WORKSPACE_ROOT = tempDir;
    process.env.KODEKS_DB_PATH = join(tempDir, 'kodeks.sqlite3');
    process.env.KODEKS_BRIDGE_BASE_URL = `http://127.0.0.1:${blockedPort}/v1`;

    try {
      const response = new Response(
        streamKodeksChat({
          input: 'hello',
          mode: 'act',
          provider: 'moonbridge',
          reasoning_effort: 'low'
        })
      );
      const body = await response.text();

      expect(body).toContain('event: error');
      expect(body).toContain('moonbridge_start_failed');
      expect(body).toContain('MoonBridge could not start');
    } finally {
      await closeServer(blockingServer);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// Starts a fake DeepSeek-compatible streaming endpoint for MoonBridge integration tests.
async function startFakeDeepSeekServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl_moonbridge',
        choices: [{ delta: { content: 'Hello from managed MoonBridge' } }]
      })}\n\n`
    );
    response.write(
      `data: ${JSON.stringify({
        id: 'chatcmpl_moonbridge',
        choices: [{ delta: {}, finish_reason: 'stop' }]
      })}\n\n`
    );
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await listen(server, 0);
  return server;
}

// Starts a non-bridge loopback server so MoonBridge health checks fail before bind retry.
async function startUnhealthyServer(): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end('not a bridge');
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
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => resolveListen());
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

describe('resolveModelClientOptions', () => {
  it('prefers built-in bridge Responses configuration when enabled', () => {
    expect(
      resolveModelClientOptions({
        KODEKS_BRIDGE_ENABLED: 'true',
        KODEKS_BRIDGE_BASE_URL: 'http://127.0.0.1:38440/v1/',
        KODEKS_BRIDGE_MODEL: 'bridge',
        DEEPSEEK_API_KEY: 'deepseek-key',
        OPENAI_API_KEY: 'openai-key'
      })
    ).toEqual({
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'bridge',
      reasoningEffort: 'high',
      provider: 'bridge'
    });
  });

  it('uses bridge defaults when explicitly selected', () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: 'bridge'
      })
    ).toEqual({
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'bridge',
      reasoningEffort: 'high',
      provider: 'bridge'
    });
  });

  it('keeps Moon Bridge names as compatibility aliases', () => {
    expect(
      resolveModelClientOptions({
        KODEKS_MODEL_PROVIDER: 'moonbridge',
        MOONBRIDGE_MODEL: 'moonbridge'
      })
    ).toEqual({
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'moonbridge',
      reasoningEffort: 'high',
      provider: 'moonbridge'
    });
  });

  it('lets a request-level provider override force MoonBridge', () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: 'openai-key',
          MOONBRIDGE_MODEL: 'moonbridge-session'
        },
        undefined,
        'moonbridge'
      )
    ).toEqual({
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'moonbridge-session',
      reasoningEffort: 'high',
      provider: 'moonbridge'
    });
  });

  it('lets a request-level provider override force Bridge', () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: 'openai-key',
          KODEKS_BRIDGE_MODEL: 'bridge-session'
        },
        undefined,
        'bridge'
      )
    ).toEqual({
      apiKey: 'bridge',
      baseURL: 'http://127.0.0.1:38440/v1',
      model: 'bridge-session',
      reasoningEffort: 'high',
      provider: 'bridge'
    });
  });

  it('lets a request-level provider override force DeepSeek', () => {
    expect(
      resolveModelClientOptions(
        {
          OPENAI_API_KEY: 'openai-key',
          DEEPSEEK_API_KEY: 'deepseek-key'
        },
        undefined,
        'deepseek'
      )
    ).toEqual({
      apiKey: 'deepseek-key',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      provider: 'deepseek'
    });
  });

  it('prefers OpenAI Agents SDK configuration over DeepSeek fallback', () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: 'deepseek-key',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.test',
        DEEPSEEK_MODEL: 'deepseek-test',
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://example.test/v1',
        OPENAI_MODEL: 'gpt-test'
      })
    ).toEqual({
      apiKey: 'openai-key',
      baseURL: 'https://example.test/v1',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      provider: 'openai'
    });
  });

  it('defaults to DeepSeek V4 Pro with high reasoning effort', () => {
    expect(
      resolveModelClientOptions({
        DEEPSEEK_API_KEY: 'deepseek-key'
      })
    ).toEqual({
      apiKey: 'deepseek-key',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
      provider: 'deepseek'
    });
  });

  it('accepts a valid request-level reasoning effort', () => {
    expect(
      resolveModelClientOptions(
        {
          DEEPSEEK_API_KEY: 'deepseek-key'
        },
        'xhigh'
      )
    ).toMatchObject({
      reasoningEffort: 'xhigh'
    });
  });

  it('falls back to OpenAI Responses when DeepSeek is not configured', () => {
    expect(
      resolveModelClientOptions({
        OPENAI_API_KEY: 'openai-key',
        OPENAI_BASE_URL: 'https://example.test/v1',
        OPENAI_MODEL: 'gpt-test'
      })
    ).toEqual({
      apiKey: 'openai-key',
      baseURL: 'https://example.test/v1',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      provider: 'openai'
    });
  });

  it('returns null when no supported provider key is configured', () => {
    expect(resolveModelClientOptions({})).toBeNull();
  });
});
