import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse
} from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  createBridgeServer,
  fromDeepSeekStream,
  type ResponsesBridgeOptions,
  toCoreRequest,
  toDeepSeekChatRequest
} from './index';

describe('createBridgeServer', () => {
  it('serves health and model-list endpoints without a DeepSeek key', async () => {
    await expect(requestBridgeJson('/health')).resolves.toEqual({
      status: 200,
      body: { ok: true }
    });
    await expect(requestBridgeJson('/v1/models')).resolves.toEqual({
      status: 200,
      body: {
        object: 'list',
        data: [{ id: 'bridge', object: 'model', owned_by: 'kodeks' }],
        models: [{ id: 'bridge', object: 'model', owned_by: 'kodeks' }]
      }
    });
  });

  it('proxies Responses requests to DeepSeek and streams Responses events', async () => {
    const fetchCalls: Array<{
      url: string;
      init: RequestInit;
      payload: Record<string, unknown>;
    }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      fetchCalls.push({ url: String(url), init: init ?? {}, payload });
      return new Response(
        [
          sseData({
            id: 'chatcmpl_bridge',
            choices: [{ delta: { content: 'Hello from bridge' } }]
          }),
          sseData({
            id: 'chatcmpl_bridge',
            choices: [{ delta: {}, finish_reason: 'stop' }]
          }),
          'data: [DONE]\n\n'
        ].join(''),
        { status: 200 }
      );
    };

    const response = await requestBridge('/v1/responses', {
      method: 'POST',
      body: {
        model: 'moonbridge',
        instructions: 'Follow local policy.',
        input: 'Say hello.',
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object' }
          }
        ],
        reasoning: { effort: 'none' },
        stream: true
      },
      bridgeOptions: {
        deepSeekApiKey: 'deepseek-key',
        deepSeekBaseURL: 'https://deepseek.test/',
        deepSeekModel: 'deepseek-local',
        fetch: fetchImpl
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({
      url: 'https://deepseek.test/chat/completions'
    });
    expect(fetchCalls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'Content-Type': 'application/json'
    });
    expect(fetchCalls[0]?.payload).toMatchObject({
      model: 'deepseek-local',
      stream: true,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: 'Follow local policy.' },
        { role: 'user', content: 'Say hello.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object' }
          }
        }
      ]
    });
    expect(response.body).toContain('event: response.output_text.delta');
    expect(response.body).toContain('"delta":"Hello from bridge"');
    expect(response.body).toContain('event: response.completed');
    expect(response.body).toContain('"model":"moonbridge"');
    expect(response.body).toContain('data: [DONE]');
  });

  it('fails Responses requests early when no DeepSeek key is configured', async () => {
    await expect(
      requestBridge('/v1/responses', {
        method: 'POST',
        body: { model: 'bridge', input: 'hello', stream: true }
      })
    ).resolves.toMatchObject({
      status: 500,
      body: expect.stringContaining('KODEKS_BRIDGE_DEEPSEEK_API_KEY')
    });
  });
});

describe('toCoreRequest', () => {
  it('maps Responses messages, function calls, and tool outputs to Core IR', () => {
    const core = toCoreRequest({
      model: 'bridge',
      instructions: 'Follow the policy.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Read package.json' }]
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"package.json"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"name":"kodeks"}'
        }
      ],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' }
        }
      ],
      reasoning: { effort: 'xhigh' },
      stream: true
    });

    expect(core).toMatchObject({
      model: 'bridge',
      reasoningEffort: 'xhigh',
      stream: true,
      messages: [
        { role: 'system', content: 'Follow the policy.' },
        { role: 'user', content: 'Read package.json' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'read_file',
              argumentsText: '{"path":"package.json"}'
            }
          ]
        },
        {
          role: 'tool',
          content: '{"name":"kodeks"}',
          toolCallId: 'call_1'
        }
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object' }
        }
      ]
    });
  });
});

describe('toDeepSeekChatRequest', () => {
  it('maps Core IR to DeepSeek Chat Completions payload', () => {
    const payload = toDeepSeekChatRequest(
      {
        model: 'bridge',
        reasoningEffort: 'xhigh',
        stream: true,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object' }
          }
        ],
        messages: [
          { role: 'system', content: 'Follow the policy.' },
          { role: 'user', content: 'Read package.json' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call_1',
                name: 'read_file',
                argumentsText: '{"path":"package.json"}'
              }
            ]
          },
          {
            role: 'tool',
            content: '{"name":"kodeks"}',
            toolCallId: 'call_1'
          }
        ]
      },
      { model: 'deepseek-v4-pro' }
    );

    expect(payload).toMatchObject({
      model: 'deepseek-v4-pro',
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      messages: [
        { role: 'system', content: 'Follow the policy.' },
        { role: 'user', content: 'Read package.json' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"package.json"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          content: '{"name":"kodeks"}',
          tool_call_id: 'call_1'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object' }
          }
        }
      ]
    });
  });
});

describe('fromDeepSeekStream', () => {
  it('maps text, tool calls, completion, and errors to Responses events', async () => {
    const events = [];
    for await (const event of fromDeepSeekStream(
      [
        {
          id: 'chatcmpl_1',
          choices: [{ delta: { content: 'Hello' } }]
        },
        {
          id: 'chatcmpl_1',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'read_file', arguments: '{"path":' }
                  }
                ]
              }
            }
          ]
        },
        {
          id: 'chatcmpl_1',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"package.json"}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        },
        {
          id: 'chatcmpl_2',
          choices: [{ delta: {}, finish_reason: 'stop' }]
        },
        { error: { message: 'upstream failed' } }
      ],
      { model: 'bridge' }
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        type: 'response.output_text.delta',
        delta: 'Hello'
      }),
      expect.objectContaining({
        type: 'response.output_item.done',
        item: expect.objectContaining({
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"package.json"}'
        })
      }),
      expect.objectContaining({
        type: 'response.completed',
        response: expect.objectContaining({
          id: 'chatcmpl_2',
          model: 'bridge',
          status: 'completed'
        })
      }),
      { type: 'error', message: 'upstream failed' }
    ]);
  });
});

// 直接调用 bridge request listener，避免单元测试依赖本地 TCP 监听权限。
async function requestBridgeJson(path: string): Promise<{
  status: number;
  body: unknown;
}> {
  const result = await requestBridge(path);
  return {
    status: result.status,
    body: JSON.parse(result.body) as unknown
  };
}

// 直接调用 bridge request listener，覆盖 GET/POST 路由且不依赖本地 TCP 权限。
async function requestBridge(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    bridgeOptions?: ResponsesBridgeOptions;
  } = {}
): Promise<{
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
}> {
  const server = createBridgeServer({
    modelAliases: ['bridge'],
    ...options.bridgeOptions
  });
  const listener = server.listeners('request')[0] as (
    request: IncomingMessage,
    response: ServerResponse
  ) => void;
  const response = createMockResponse();

  listener(
    createMockRequest({
      method: options.method ?? 'GET',
      url: path,
      body: options.body
    }),
    response.message
  );

  return response.done;
}

// 创建最小 IncomingMessage 替身，支持 request listener 读取 JSON body。
function createMockRequest(input: {
  method: string;
  url: string;
  body?: unknown;
}): IncomingMessage {
  const rawBody =
    input.body === undefined
      ? undefined
      : Buffer.from(JSON.stringify(input.body));
  return {
    method: input.method,
    url: input.url,
    async *[Symbol.asyncIterator]() {
      if (rawBody !== undefined) {
        yield rawBody;
      }
    }
  } as IncomingMessage;
}

// 创建最小 ServerResponse 替身，只实现当前路由测试需要的写出 API。
function createMockResponse(): {
  message: ServerResponse;
  done: Promise<{
    status: number;
    headers: OutgoingHttpHeaders;
    body: string;
  }>;
} {
  let status = 0;
  let headers: OutgoingHttpHeaders = {};
  let body = '';
  let resolveDone: (result: {
    status: number;
    headers: OutgoingHttpHeaders;
    body: string;
  }) => void;
  const done = new Promise<{
    status: number;
    headers: OutgoingHttpHeaders;
    body: string;
  }>((resolve) => {
    resolveDone = resolve;
  });
  const message = {
    writeHead(nextStatus: number, nextHeaders?: OutgoingHttpHeaders) {
      status = nextStatus;
      headers = nextHeaders ?? {};
      return message;
    },
    write(chunk: string | Buffer) {
      body += chunk.toString();
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        body += chunk.toString();
      }
      resolveDone({ status, headers, body });
      return message;
    }
  } as ServerResponse;

  return { message, done };
}

// 序列化测试用 DeepSeek SSE chunk。
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
