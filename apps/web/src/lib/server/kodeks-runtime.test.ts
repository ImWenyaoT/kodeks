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
});

describe('resolveModelClientOptions', () => {
  it('prefers built-in bridge Responses configuration when enabled', () => {
    expect(
      resolveModelClientOptions({
        KODEKS_BRIDGE_ENABLED: 'true',
        KODEKS_BRIDGE_BASE_URL: 'http://127.0.0.1:38440/v1',
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
