// frontend/lib/server/bridge/bridge.test.ts
// MoonBridge 双向桥保真测试:逐字段对照移植自 Python tests/test_bridge.py。
//  · 请求映射用例:逐字段 toEqual,期望值取自 Python 断言。
//  · 响应映射用例:把 chunks 数组喂给 fromDeepseekStream,用 for await 收集事件后逐字段比对。
// 门禁:这些用例全过 = 与 Python 行为完全一致。
import { describe, expect, it } from 'vitest'
import { fromDeepseekStream } from './response'
import { toDeepseekChatRequest } from './request'

/**
 * 把 fromDeepseekStream 的 async generator 收集为数组（复刻 Python `[e async for e in ...]`）。
 */
async function collect(
  stream: AsyncGenerator<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

describe('请求映射 Responses → Chat Completions', () => {
  it('把 Responses 形状请求转为带 tools 的 Chat Completions（含 effort=none）', () => {
    const payload = toDeepseekChatRequest(
      {
        model: 'bridge',
        instructions: 'Be concise.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hi' }],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'read_file',
            description: 'Read',
            parameters: { type: 'object', properties: {} },
          },
        ],
        reasoning: { effort: 'none' },
      },
      'deepseek-v4-pro',
    )

    expect(payload.model).toBe('deepseek-v4-pro')
    expect(payload.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hi' },
    ])
    expect(payload.thinking).toEqual({ type: 'disabled' })
    expect(payload.tool_choice).toBe('auto')
    expect((payload.tools as Record<string, Record<string, unknown>>[])[0].function.name).toBe(
      'read_file',
    )
  })

  it('把 Kodeks 扁平工具定义转为 Chat Completions 工具', () => {
    const payload = toDeepseekChatRequest(
      {
        model: 'bridge',
        input: 'read the file',
        tools: [
          {
            name: 'read_file',
            description: 'Read a workspace file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      },
      'deepseek-v4-pro',
    )

    expect(payload.tool_choice).toBe('auto')
    expect(payload.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a workspace file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ])
  })

  it('过滤掉 hosted OpenAI 工具,只转发本地 function 工具', () => {
    const payload = toDeepseekChatRequest(
      {
        model: 'bridge',
        input: 'hi',
        tools: [
          { type: 'web_search_preview' },
          {
            type: 'function',
            name: 'read_file',
            description: 'Read',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
      'deepseek-v4-pro',
    )

    const names = (payload.tools as Record<string, Record<string, unknown>>[]).map(
      (tool) => tool.function.name,
    )
    expect(names).toEqual(['read_file'])
  })

  it('function_call replay 项保留空 content + reasoning 元数据', () => {
    const payload = toDeepseekChatRequest(
      {
        model: 'bridge',
        instructions: 'Follow the policy.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Read package.json' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            reasoning_content: 'Need package metadata.',
            arguments: '{"path":"package.json"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '{"name":"kodeks"}',
          },
        ],
        tools: [],
        reasoning: { effort: 'xhigh' },
      },
      'deepseek-v4-pro',
    )

    expect(payload.messages).toEqual([
      { role: 'system', content: 'Follow the policy.' },
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need package metadata.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"package.json"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"name":"kodeks"}',
        tool_call_id: 'call_1',
      },
    ])
    expect(payload.thinking).toEqual({ type: 'enabled' })
    expect(payload.reasoning_effort).toBe('max')
  })

  it('多个 replay function_call 合并为一条 assistant tool-call 消息', () => {
    const payload = toDeepseekChatRequest(
      {
        model: 'bridge',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect files' }],
          },
          {
            type: 'function_call',
            call_id: 'call_read_test',
            name: 'read_file',
            reasoning_content: 'Need both files.',
            arguments: '{"path":"tests/test_text_tools.py"}',
          },
          {
            type: 'function_call',
            call_id: 'call_read_src',
            name: 'read_file',
            reasoning_content: 'Need both files.',
            arguments: '{"path":"src/text_tools.py"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_read_test',
            output: '{"ok":true}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_read_src',
            output: '{"ok":true}',
          },
        ],
        tools: [],
      },
      'deepseek-v4-pro',
    )

    const messages = payload.messages as Record<string, unknown>[]
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
    ])
    const assistant = messages[1]
    expect(assistant.reasoning_content).toBe('Need both files.')
    expect((assistant.tool_calls as Record<string, unknown>[]).map((tc) => tc.id)).toEqual([
      'call_read_test',
      'call_read_src',
    ])
  })
})

describe('响应映射 Chat Completions chunk → Responses 事件', () => {
  it('上游 error 变成终态 response.failed 事件', async () => {
    const events = await collect(
      fromDeepseekStream([{ error: { message: 'boom' } }], {
        responseId: 'resp_test',
        model: 'bridge',
      }),
    )

    expect(events).toEqual([
      {
        type: 'response.failed',
        response: {
          id: 'resp_test',
          model: 'bridge',
          status: 'failed',
          error: { message: 'boom' },
          output: [
            {
              id: 'msg_resp_test_failed',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'MoonBridge upstream failed: boom',
                  annotations: [],
                },
              ],
            },
          ],
        },
      },
    ])
  })

  it('tool-call 输出保留 DeepSeek reasoning_content 供 replay', async () => {
    const chunks = [
      {
        id: 'resp_1',
        choices: [
          {
            delta: {
              reasoning_content: 'private',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]

    const events = await collect(fromDeepseekStream(chunks, { model: 'bridge' }))

    expect(events[0].type).toBe('response.output_item.done')
    expect((events[0].item as Record<string, unknown>).reasoning_content).toBe('private')
    expect(events[1].type).toBe('response.completed')
  })

  it('chunk 合并:覆盖 id/name,仅拼接 arguments;文本 delta 与 completed 形状', async () => {
    const chunks = [
      {
        id: 'chatcmpl_1',
        choices: [
          {
            delta: {
              content: 'Hello',
            },
          },
        ],
      },
      {
        id: 'chatcmpl_1',
        choices: [
          {
            delta: {
              reasoning_content: 'Need the package metadata.',
            },
          },
        ],
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
                  function: {
                    name: 'read_file',
                    arguments: '{"path":',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: 'chatcmpl_1',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '"package.json"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { error: { message: 'upstream failed' } },
    ]

    const events = await collect(fromDeepseekStream(chunks, { model: 'bridge' }))

    expect(events[0]).toEqual({
      type: 'response.output_text.delta',
      delta: 'Hello',
      output_index: 0,
      content_index: 0,
      item_id: 'msg_chatcmpl_1',
    })
    expect(events[1].type).toBe('response.output_item.done')
    expect(events[1].item).toEqual({
      id: 'fc_call_1',
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"package.json"}',
      status: 'completed',
      reasoning_content: 'Need the package metadata.',
    })
    expect(events[2].type).toBe('response.completed')
    const completed = events[2].response as Record<string, unknown>
    const output = completed.output as Record<string, unknown>[]
    expect(
      ((output[0].content as Record<string, unknown>[])[0] as Record<string, unknown>).text,
    ).toBe('Hello')
    expect(output[1].call_id).toBe('call_1')
    expect(events[3].type).toBe('response.failed')
    const failed = events[3].response as Record<string, unknown>
    const failedOutput = failed.output as Record<string, unknown>[]
    expect(
      ((failedOutput[0].content as Record<string, unknown>[])[0] as Record<string, unknown>).text,
    ).toBe('MoonBridge upstream failed: upstream failed')
  })
})
