// frontend/lib/server/bridge/request.ts
// MoonBridge 请求方向：把 OpenAI Responses 协议的请求逐字段映射到 OpenAI 兼容
// Chat Completions（DeepSeek）请求。逐字节忠实移植自 Python providers/bridge.py:14-131,256-349。
// 纯函数,不依赖任何运行时/配置;被路由层与测试共用。
//
// 保真红线（见 .remember/migration-specs/10-bridge.md「保真风险」）：
//  · Python `x or "{}"` 对空串也回退 —— 一律用 `||` 复刻,绝不用 `??`。
//  · assistant 有 tool_calls 时 content 空串保留 `''`;无 tool_calls 时空串 → null。
//  · DeepSeek payload 字段仅:model/messages/(tools+tool_choice)/thinking(+reasoning_effort)/stream。
//    temperature/max_tokens/stop/top_p 等全部丢弃;tool_choice 恒为 'auto'。

/** 内部 core 形状的消息（camelCase 字段:toolCallId/toolCalls/argumentsText/reasoningContent）。 */
type CoreMessage = Record<string, unknown>

/** 归一化后的 function 工具:仅保留 name/description/parameters 三字段。 */
type CoreTool = { name: string; description: string; parameters: Record<string, unknown> }

/** to_core_request 的归一化结果:内部 core 请求形状。 */
type CoreRequest = {
  model: string
  messages: CoreMessage[]
  tools: CoreTool[]
  reasoningEffort: string
}

/** 复刻 Python 真值判定:仅 falsy（''/0/null/undefined/NaN/false）为假,与 Python `or` 对齐。 */
function isTruthy(value: unknown): boolean {
  return Boolean(value)
}

/** 复刻 Python `isinstance(x, str)`:仅 JS string 视为字符串。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 复刻 Python `isinstance(x, dict)`:普通对象（非 null、非数组）视为 dict。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从内容字段抽取纯文本（移植 _text_from_content,bridge.py:336-349）。
 * str 直接返回;list 时对每个 dict item 按顺序尝试 key (text/output_text/input_text),
 * 取首个为 str 的值并 break,最后 join;其它返回 ''。
 */
function textFromContent(content: unknown): string {
  if (isString(content)) return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (isDict(item)) {
        for (const key of ['text', 'output_text', 'input_text'] as const) {
          const text = item[key]
          if (isString(text)) {
            parts.push(text)
            break
          }
        }
      }
    }
    return parts.join('')
  }
  return ''
}

/**
 * 把单个 Responses input item 映射为内部 core message（移植 _input_item_to_message,bridge.py:256-287）。
 * 按 item.type 分派:function_call_output → tool;function_call → assistant+toolCalls;
 * 否则若 role ∈ {user,assistant,system} → 普通文本消息;其它返回 null（丢弃）。
 * 注意 arguments 缺省回退 '{}'（非空串,用 `||` 复刻 Python `or`）。
 */
function inputItemToMessage(item: unknown): CoreMessage | null {
  if (!isDict(item)) return null
  const itemType = item.type
  if (itemType === 'function_call_output') {
    return {
      role: 'tool',
      content: String(item.output || ''),
      toolCallId: String(item.call_id || ''),
    }
  }
  if (itemType === 'function_call') {
    const message: CoreMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: String(item.call_id || ''),
          name: String(item.name || ''),
          argumentsText: String(item.arguments || '{}'),
        },
      ],
    }
    // 仅当 reasoning_content 是 str 时才附带 reasoningContent 字段。
    if (isString(item.reasoning_content)) {
      message.reasoningContent = item.reasoning_content
    }
    return message
  }
  const role = item.role
  const content = item.content
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return { role, content: textFromContent(content) }
  }
  return null
}

/**
 * 合并相邻的 assistant tool_call 消息为一条（移植 _merge_assistant_tool_call_messages,bridge.py:107-131）。
 * 当前消息是 assistant 且 toolCalls 非空 list,且前一条 merged 也是 assistant 且其 toolCalls 是 list 时:
 * 把当前 toolCalls 追加到前一条,并在前一条无 reasoningContent 时继承当前的,然后跳过单独追加。
 */
function mergeAssistantToolCallMessages(messages: CoreMessage[]): CoreMessage[] {
  const merged: CoreMessage[] = []
  for (const message of messages) {
    const toolCalls = message.toolCalls
    const previous = merged.length > 0 ? merged[merged.length - 1] : null
    if (
      message.role === 'assistant' &&
      Array.isArray(toolCalls) &&
      toolCalls.length > 0 &&
      previous !== null &&
      previous.role === 'assistant' &&
      Array.isArray(previous.toolCalls)
    ) {
      previous.toolCalls = [...(previous.toolCalls as unknown[]), ...toolCalls]
      // 前一条无 reasoningContent 且当前是 str 时继承。
      if (!isTruthy(previous.reasoningContent) && isString(message.reasoningContent)) {
        previous.reasoningContent = message.reasoningContent
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

/**
 * 归一化 Responses 风格或 Kodeks 扁平风格的 function 工具定义（移植 _normalize_function_tool,bridge.py:75-104）。
 * 接受三种形态:type=function 且 function 是 dict（从 function 取）;type=function 但 function 非 dict（从顶层取）;
 * type 缺失且 name 是 str（Kodeks 扁平形态,从顶层取）。其它返回 null。
 * name 必须是 strip 后非空的 str,否则返回 null。非 function 工具（如 web_search_preview）被丢弃。
 */
function normalizeFunctionTool(value: unknown): CoreTool | null {
  if (!isDict(value)) return null
  let name: unknown
  let description: unknown
  let parameters: unknown
  if (value.type === 'function') {
    const fn = value.function
    if (isDict(fn)) {
      name = fn.name
      description = fn.description
      parameters = fn.parameters
    } else {
      name = value.name
      description = value.description
      parameters = value.parameters
    }
  } else if (value.type === undefined && isString(value.name)) {
    name = value.name
    description = value.description
    parameters = value.parameters
  } else {
    return null
  }
  if (!isString(name) || name.trim() === '') return null
  return {
    name,
    description: isString(description) ? description : '',
    parameters: isDict(parameters) ? parameters : { type: 'object', properties: {} },
  }
}

/**
 * 把一条内部 core message 映射为 DeepSeek Chat Completions message（移植 _to_deepseek_chat_message,bridge.py:290-324）。
 * tool 角色 → {role,content,tool_call_id};assistant 角色按是否有 tool_calls 分两支;其它（user/system）直接 str 化。
 * 关键回退:assistant 无 tool_calls 时 content 空串 → null;有 tool_calls 时空串保留 ''。arguments 回退 '{}'。
 */
function toDeepseekChatMessage(message: CoreMessage): Record<string, unknown> {
  const role = message.role
  if (role === 'tool') {
    return {
      role: 'tool',
      content: String(message.content || ''),
      tool_call_id: String(message.toolCallId || ''),
    }
  }
  if (role === 'assistant') {
    const rawToolCalls = message.toolCalls
    const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : []
    const hasToolCalls = toolCalls.length > 0
    const content = message.content
    // 默认:空串 → null（与 has_tool_calls 分支不同）。
    const result: Record<string, unknown> = {
      role: 'assistant',
      content: isString(content) && content ? String(content) : null,
    }
    if (isString(message.reasoningContent)) {
      result.reasoning_content = message.reasoningContent
    }
    if (hasToolCalls) {
      // 有工具调用时空串保留为 ''（而非 null）。
      result.content = isString(content) ? String(content) : ''
      result.tool_calls = toolCalls
        .filter((toolCall) => isDict(toolCall))
        .map((toolCall) => {
          const tc = toolCall as Record<string, unknown>
          return {
            id: String(tc.id || ''),
            type: 'function',
            function: {
              name: String(tc.name || ''),
              arguments: String(tc.argumentsText || '{}'),
            },
          }
        })
    }
    return result
  }
  return { role, content: String(message.content || '') }
}

/**
 * reasoning effort → DeepSeek thinking / reasoning_effort 选项（移植 _to_deepseek_thinking_options,bridge.py:327-333）。
 * none → {thinking:{type:'disabled'}};xhigh → max;其它一切（含 low/medium/high/未知）→ high。
 */
function toDeepseekThinkingOptions(reasoningEffort: string): Record<string, unknown> {
  if (reasoningEffort === 'none') {
    return { thinking: { type: 'disabled' } }
  }
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffort === 'xhigh' ? 'max' : 'high',
  }
}

/**
 * 把 Responses 风格请求归一化为内部 core 请求形状（移植 to_core_request,bridge.py:44-72）。
 * 顺序:instructions（非空 str）→ system 头;input（str 或 list）→ messages;合并相邻 assistant tool_calls;
 * tools 逐项归一化（丢弃非 function）;reasoning.effort 回退 'high'。
 */
function toCoreRequest(request: Record<string, unknown>): CoreRequest {
  let messages: CoreMessage[] = []
  const instructions = request.instructions
  if (isString(instructions) && instructions) {
    messages.push({ role: 'system', content: instructions })
  }
  const rawInput = request.input ?? []
  if (isString(rawInput)) {
    messages.push({ role: 'user', content: rawInput })
  } else if (Array.isArray(rawInput)) {
    for (const item of rawInput) {
      const mapped = inputItemToMessage(item)
      if (mapped !== null) messages.push(mapped)
    }
  }
  messages = mergeAssistantToolCallMessages(messages)
  const rawTools = Array.isArray(request.tools) ? request.tools : []
  const tools: CoreTool[] = []
  for (const rawTool of rawTools) {
    const tool = normalizeFunctionTool(rawTool)
    if (tool !== null) tools.push(tool)
  }
  const reasoning = request.reasoning
  const effort = isDict(reasoning) ? reasoning.effort : null
  return {
    model: String(request.model || 'bridge'),
    messages,
    tools,
    // effort 回退 'high'（Python `effort or "high"`,空串也回退）。
    reasoningEffort: isString(effort) && effort ? effort : 'high',
  }
}

/**
 * 把 Responses 风格请求转换为 Chat Completions（DeepSeek）请求（移植 to_deepseek_chat_request,bridge.py:14-41）。
 * 先归一化为 core,再包装 tools 为 Chat Completions 工具;最终 payload 仅含:
 * model、messages、(tools 非空时)tools+tool_choice、thinking(+可选 reasoning_effort)、stream:true。
 * @param request Responses 风格请求体（宽松对象）。
 * @param model 可选模型 id;为空时回退 core.model 再回退 'bridge'。
 */
export function toDeepseekChatRequest(
  request: Record<string, unknown>,
  model?: string | null,
): Record<string, unknown> {
  const core = toCoreRequest(request)
  const tools = core.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
  return {
    model: model || String(core.model || 'bridge'),
    messages: core.messages.map((message) => toDeepseekChatMessage(message)),
    // 仅 tools 非空才注入 tools + tool_choice:'auto'。
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...toDeepseekThinkingOptions(String(core.reasoningEffort || 'high')),
    stream: true,
  }
}
