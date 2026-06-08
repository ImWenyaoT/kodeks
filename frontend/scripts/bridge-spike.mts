/**
 * M0 桥 spike：验证「openai 客户端(responses 模式) + 进程内自定义 fetch → DeepSeek(ChatCompletions)」这条链路是否打通。
 *
 * 目标（最高风险点）：探明官方 `openai` node SDK 的 Responses 流式解析器到底需要哪些事件，
 * 才能把 DeepSeek 的 chat.completion.chunk 正确映射回 Responses 事件，让客户端解析出文本增量与最终响应。
 *
 * 运行：在 frontend/ 下执行
 *   node --env-file=../.env.local scripts/bridge-spike.mts
 * （--env-file 负责把 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL 注入 process.env，代码不接触密钥明文）
 */

/* eslint-disable @typescript-eslint/no-explicit-any --
   探索性 M0 spike：刻意用 any 快速读取无类型的 Responses/DeepSeek JSON 以验证链路。
   产品化版本在 M1 移入 frontend/lib/server/bridge/，届时改为 openai/zod 强类型。 */
import OpenAI from 'openai'
import { Agent, run, setDefaultOpenAIClient, setOpenAIAPI, setTracingDisabled } from '@openai/agents'

// ── 配置（复用 Python 端 .env.local 的 DeepSeek 凭据；无 MODEL 则用项目默认）────────────────
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro'

if (!DEEPSEEK_API_KEY) {
  console.error('缺少 DEEPSEEK_API_KEY（请用 --env-file=../.env.local 运行）')
  process.exit(1)
}

const encoder = new TextEncoder()

/**
 * 把一个 Responses 流式事件编码为一条 SSE 帧（event + 紧凑 JSON data）。
 * openai 客户端解析器既读 event 行也读 data，内部以 data 里的 type 字段为准。
 */
function sseFrame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

/**
 * 把 Responses 风格请求体转换为 DeepSeek(ChatCompletions) 请求体（M0 最小版，移植自 providers/bridge.py）。
 * 仅覆盖 spike 需要的子集：instructions→system、input(str|array)→messages、tools、reasoning.effort→thinking。
 */
function toDeepseekChatRequest(req: Record<string, any>): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = []
  if (typeof req.instructions === 'string' && req.instructions) {
    messages.push({ role: 'system', content: req.instructions })
  }
  const input = req.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const mapped = inputItemToMessage(item)
      if (mapped) messages.push(mapped)
    }
  }
  const tools = Array.isArray(req.tools)
    ? req.tools
        .map((t: any) => normalizeFunctionTool(t))
        .filter((t: any): t is Record<string, unknown> => t !== null)
    : []
  const effort: string = req.reasoning?.effort ?? 'high'
  return {
    model: DEEPSEEK_MODEL,
    messages,
    ...(tools.length
      ? {
          tools: tools.map((t: any) => ({
            type: 'function',
            function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
          })),
          tool_choice: 'auto',
        }
      : {}),
    ...thinkingOptions(effort),
    stream: true,
  }
}

/** 把单个 Responses 输入项映射为 ChatCompletions 消息（message / function_call / function_call_output）。 */
function inputItemToMessage(item: any): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'function_call_output') {
    return { role: 'tool', content: String(item.output ?? ''), tool_call_id: String(item.call_id ?? '') }
  }
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: String(item.call_id ?? ''),
          type: 'function',
          function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '{}') },
        },
      ],
    }
  }
  if (item.role === 'user' || item.role === 'assistant' || item.role === 'system') {
    return { role: item.role, content: textFromContent(item.content) }
  }
  return null
}

/** 归一化 Responses/Kodeks 两种 function tool 定义形态。 */
function normalizeFunctionTool(value: any): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  let name: unknown, description: unknown, parameters: unknown
  if (value.type === 'function') {
    const fn = value.function
    if (fn && typeof fn === 'object') ({ name, description, parameters } = fn)
    else ({ name, description, parameters } = value)
  } else if (value.type == null && typeof value.name === 'string') {
    ;({ name, description, parameters } = value)
  } else return null
  if (typeof name !== 'string' || !name.trim()) return null
  return {
    name,
    description: typeof description === 'string' ? description : '',
    parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', properties: {} },
  }
}

/** 从 Responses content 提取纯文本。 */
function textFromContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p && typeof p === 'object' ? p.text ?? p.output_text ?? p.input_text ?? '' : ''))
      .join('')
  }
  return ''
}

/** DeepSeek thinking/effort 选项（移植自 bridge.py 默认行为）。 */
function thinkingOptions(effort: string): Record<string, unknown> {
  if (effort === 'none') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort === 'xhigh' ? 'max' : 'high' }
}

/**
 * 把 DeepSeek 的 ChatCompletions SSE 流转换为 Responses 风格 SSE 流（ReadableStream）。
 * 关键：发出官方 Responses 解析器期望的完整事件链（created→in_progress→output_item.added→
 * content_part.added→output_text.delta*→output_text.done→content_part.done→output_item.done→completed）。
 * spike 的核心就是验证「这一串事件」是否被官方解析器接受。
 */
function responsesSseFromDeepseek(deepseekBody: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const responseId = 'resp_bridge_spike'
  const itemId = `msg_${responseId}`
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0
      const emit = (e: Record<string, unknown>) => controller.enqueue(sseFrame({ ...e, sequence_number: seq++ }))
      const baseResponse = (status: string, output: unknown[]) => ({
        id: responseId,
        object: 'response',
        created_at: 0,
        status,
        model,
        output,
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
      })

      // 流开始：created + in_progress
      emit({ type: 'response.created', response: baseResponse('in_progress', []) })
      emit({ type: 'response.in_progress', response: baseResponse('in_progress', []) })

      let messageOpen = false
      let text = ''
      let reasoning = ''

      const openMessage = () => {
        if (messageOpen) return
        messageOpen = true
        emit({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        })
        emit({
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      }

      // 读 DeepSeek SSE
      const reader = deepseekBody.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      try {
        while (!finished) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let nl: number
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              finished = true
              break
            }
            let chunk: any
            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }
            const choice = chunk?.choices?.[0] ?? {}
            const delta = choice.delta ?? {}
            if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
            if (typeof delta.content === 'string' && delta.content) {
              openMessage()
              text += delta.content
              emit({
                type: 'response.output_text.delta',
                item_id: itemId,
                output_index: 0,
                content_index: 0,
                delta: delta.content,
              })
            }
            // M0 spike 暂只验证文本路径；tool_calls 路径在 M1 产品化时补全
            if (choice.finish_reason) finished = true
          }
        }
      } finally {
        reader.releaseLock()
      }

      // 收尾：output_text.done → content_part.done → output_item.done → completed
      const messageItem = {
        id: itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }
      if (messageOpen) {
        emit({ type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text })
        emit({
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        })
        emit({ type: 'response.output_item.done', output_index: 0, item: messageItem })
      }
      emit({ type: 'response.completed', response: baseResponse('completed', messageOpen ? [messageItem] : []) })
      if (reasoning) console.log(`\n[debug] reasoning_content 累计 ${reasoning.length} 字（未作为文本输出）`)
      controller.close()
    },
  })
}

/**
 * 进程内桥：拦截 openai 客户端发往 /responses 的请求，转 DeepSeek ChatCompletions，再把流转回 Responses 事件。
 * 注入为 openai 客户端的 fetch，因此 app 全程用 Responses API，且无自调 HTTP 跳转。
 */
const bridgeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.endsWith('/responses')) {
    return fetch(input, init) // 非 responses 调用透传（spike 里不应发生）
  }
  const responsesReq = JSON.parse(String(init?.body ?? '{}'))
  const deepseekReq = toDeepseekChatRequest(responsesReq)
  const upstream = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'kodeks-ts-bridge-spike/0.1',
    },
    body: JSON.stringify(deepseekReq),
  })
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => '')
    return new Response(`upstream ${upstream.status}: ${body.slice(0, 300)}`, { status: upstream.status })
  }
  const stream = responsesSseFromDeepseek(upstream.body, String(deepseekReq.model))
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

async function main() {
  const client = new OpenAI({
    apiKey: 'sk-bridge-unused', // 真实凭据在 bridgeFetch 内注入到 DeepSeek 调用
    baseURL: 'http://bridge.local/v1',
    fetch: bridgeFetch,
  })

  console.log('→ 经桥调用 client.responses.create（流式，纯文本）...\n')
  const stream = await client.responses.create({
    model: DEEPSEEK_MODEL,
    input: '只回复这一句，不要别的：hello from the bridge',
    stream: true,
  })

  let assembled = ''
  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === 'response.output_text.delta') {
      assembled += event.delta
      process.stdout.write(event.delta)
    } else if (event.type === 'response.completed') {
      console.log('\n\n[event] response.completed ✓')
    }
  }
  console.log(`\n✅ [1/2] 原生 openai 客户端：成功解析出文本（${assembled.length} 字）`)

  // ── [2/2] 在桥之上叠加 @openai/agents，证明实际要用的 SDK 也走同一进程内桥/同一解析器 ──
  setDefaultOpenAIClient(client)
  setOpenAIAPI('responses')
  setTracingDisabled(true)
  const agent = new Agent({ name: 'Spike', instructions: '用一句话简短回复。', model: DEEPSEEK_MODEL })
  console.log('\n→ 经桥调用 @openai/agents run(stream:true)...')
  const agentStream = await run(agent, '用一句话打个招呼', { stream: true })
  await agentStream.completed
  console.log(`[agents] finalOutput: ${agentStream.finalOutput}`)
  console.log('\n✅ [2/2] @openai/agents：经同一进程内桥跑通 DeepSeek')
}

main().catch((err) => {
  console.error('\n❌ spike 失败：', err)
  process.exit(1)
})
