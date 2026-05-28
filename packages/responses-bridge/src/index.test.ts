import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBridgeServer,
  fromDeepSeekStream,
  toCoreRequest,
  toDeepSeekChatRequest
} from './index';

const servers: ReturnType<typeof createBridgeServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
});

describe('createBridgeServer', () => {
  it('serves health and model-list endpoints without a DeepSeek key', async () => {
    const server = createBridgeServer({ modelAliases: ['bridge'] });
    servers.push(server);
    const baseURL = await listen(server);

    await expect(
      fetch(`${baseURL}/health`).then((response) => response.json())
    ).resolves.toEqual({ ok: true });
    await expect(
      fetch(`${baseURL}/v1/models`).then((response) => response.json())
    ).resolves.toEqual({
      object: 'list',
      data: [{ id: 'bridge', object: 'model', owned_by: 'kodeks' }],
      models: [{ id: 'bridge', object: 'model', owned_by: 'kodeks' }]
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

// Listens on an ephemeral loopback port for HTTP-level bridge tests.
function listen(
  server: ReturnType<typeof createBridgeServer>
): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

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
