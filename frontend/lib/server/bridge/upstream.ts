// frontend/lib/server/bridge/upstream.ts
// MoonBridge 上游 HTTP 调用：用 Web fetch + ReadableStream 解析 SSE,把上游 Chat Completions
// 流逐 chunk yield 出来。逐字节忠实移植自 Python providers/bridge.py:134-176。
//
// 与 Python 的差异:签名改为 fetchChatCompletionsStream(payload, { apiKey, baseURL })。
// baseURL 由调用方解析（不 import config,保持本模块独立）。
//
// 保真红线（见 10-bridge.md「保真风险」）:
//  · 上游永远 stream:true（由 payload 决定,本模块不改）。
//  · base_url 调用前去尾部斜杠。
//  · SSE 只接受字面前缀 'data: '（含尾随空格）开头的行;removeprefix('data: ').trim();[DONE] 终止。
//  · JSON 解析失败的行静默跳过;非对象（非 dict）chunk 丢弃。
//  · status >= 400 时读 body 前 500 字节,yield 一个 error chunk 后 return（不抛错）。

/** 复刻 Python `isinstance(x, dict)`:普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 调用上游 Chat Completions 端点并 yield 解析后的 SSE chunk（移植 fetch_chat_completions_stream,bridge.py:134-176）。
 * @param payload 已构造好的 Chat Completions 请求体（含 stream:true）。
 * @param options apiKey 用于 Authorization;baseURL 由调用方解析（去尾斜杠后拼接 /chat/completions）。
 * @yields 每个解析成功的 chunk dict;status>=400 时 yield 单个 {error:{message}} 后结束。
 */
export async function* fetchChatCompletionsStream(
  payload: Record<string, unknown>,
  options: { apiKey: string; baseURL: string },
): AsyncGenerator<Record<string, unknown>> {
  // base_url 调用前去尾部斜杠（复刻 .rstrip("/")）。
  const baseURL = options.baseURL.replace(/\/+$/, '')
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'kodeks-python-moonbridge/0.1',
    },
    body: JSON.stringify(payload),
  })

  // status >= 400:读 body 前 500 字节,yield 一个 error chunk 后 return。
  if (response.status >= 400) {
    let body = ''
    try {
      body = (await response.text()).slice(0, 500)
    } catch {
      // 读 body 失败时按空 body 处理（与 Python decode(errors="ignore") 的容错对齐）。
      body = ''
    }
    const suffix = body ? `: ${body}` : ''
    // reason_phrase:Web fetch 用 response.statusText 对齐 httpx 的 reason_phrase。
    yield {
      error: {
        message: `Chat Completions request failed: ${response.status} ${response.statusText}${suffix}`,
      },
    }
    return
  }

  const bodyStream = response.body
  if (bodyStream === null) return

  // 用 TextDecoder 逐块解码,按行切分,严格匹配字面前缀 'data: '。
  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 处理一行 SSE:仅接受 'data: ' 前缀;[DONE] 终止;JSON 失败静默跳过;非 dict 丢弃。
  // 返回 'done' 表示遇到 [DONE] 终止符,'skip' 表示无需 yield,否则返回要 yield 的 chunk。
  function parseLine(line: string): Record<string, unknown> | 'done' | 'skip' {
    if (!line.startsWith('data: ')) return 'skip'
    const data = line.slice('data: '.length).trim()
    if (data === '[DONE]') return 'done'
    let chunk: unknown
    try {
      chunk = JSON.parse(data)
    } catch {
      return 'skip'
    }
    return isDict(chunk) ? chunk : 'skip'
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 按换行切分;保留最后一段不完整行在 buffer 中。
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        // 去掉行尾可能的 \r（httpx aiter_lines 也会规整行尾）。
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        const result = parseLine(line)
        if (result === 'done') return
        if (result !== 'skip') yield result
        newlineIndex = buffer.indexOf('\n')
      }
    }
    // flush 解码器残留字节并处理 buffer 中最后一行（无尾随换行的情形）。
    buffer += decoder.decode()
    const tail = buffer.replace(/\r$/, '')
    if (tail) {
      const result = parseLine(tail)
      if (result === 'done') return
      if (result !== 'skip') yield result
    }
  } finally {
    reader.releaseLock()
  }
}
