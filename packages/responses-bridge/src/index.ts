import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export type ResponsesBridgeOptions = {
  deepSeekApiKey?: string;
  deepSeekBaseURL?: string;
  deepSeekModel?: string;
  modelAliases?: string[];
  userAgent?: string;
  fetch?: typeof fetch;
};

export type ResponsesRequest = {
  model: string;
  input: unknown;
  instructions?: string;
  tools?: ResponsesTool[];
  reasoning?: {
    effort?: ReasoningEffort;
  };
  stream?: boolean;
};

export type ResponsesTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type CoreRequest = {
  model: string;
  instructions?: string;
  messages: CoreMessage[];
  tools: CoreTool[];
  reasoningEffort: ReasoningEffort;
  stream: boolean;
};

export type CoreMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: CoreToolCall[];
};

export type CoreTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type CoreToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

export type DeepSeekChatRequest = {
  model: string;
  messages: DeepSeekChatMessage[];
  tools: DeepSeekChatTool[];
  thinking: {
    type: 'enabled' | 'disabled';
  };
  reasoning_effort?: 'high' | 'max';
  stream: true;
};

export type DeepSeekChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: DeepSeekChatToolCall[];
    }
  | { role: 'tool'; content: string; tool_call_id: string };

export type DeepSeekChatTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DeepSeekChatToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ResponsesStreamEvent =
  | {
      type: 'response.output_text.delta';
      delta: string;
      output_index: number;
      content_index: number;
      item_id: string;
    }
  | {
      type: 'response.output_item.done';
      output_index: number;
      item: {
        id: string;
        type: 'function_call';
        call_id: string;
        name: string;
        arguments: string;
        status: 'completed';
      };
    }
  | {
      type: 'response.completed';
      response: {
        id: string;
        model: string;
        status: 'completed';
        output: unknown[];
      };
    }
  | {
      type: 'response.failed';
      response: {
        id: string;
        model: string;
        status: 'failed';
        error: {
          message: string;
        };
      };
    }
  | {
      type: 'error';
      message: string;
    };

type DeepSeekStreamChunk = {
  id?: string;
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
};

type DeepSeekToolCallDelta = {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
};

type PendingToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro';
const DEFAULT_MODEL_ALIASES = ['bridge', 'moonbridge'];

// 创建一个 Node HTTP server，用 OpenAI Responses 入口转发到 DeepSeek Chat Completions。
export function createBridgeServer(options: ResponsesBridgeOptions = {}) {
  return createServer((request, response) => {
    void handleBridgeRequest(request, response, options);
  });
}

// 把 OpenAI Responses 请求转换成协议无关 Core IR。
export function toCoreRequest(request: ResponsesRequest): CoreRequest {
  const messages: CoreMessage[] = [];
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: 'system', content: request.instructions });
  }

  for (const item of normalizeInputItems(request.input)) {
    const message = toCoreMessage(item);
    if (message !== null) {
      messages.push(message);
    }
  }

  return {
    model: request.model,
    instructions: request.instructions,
    messages,
    tools: (request.tools ?? [])
      .filter((tool) => tool.type === 'function')
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? {}
      })),
    reasoningEffort: request.reasoning?.effort ?? 'high',
    stream: request.stream !== false
  };
}

// 把 Core IR 转换为 DeepSeek Chat Completions 请求。
export function toDeepSeekChatRequest(
  request: CoreRequest,
  options: { model?: string } = {}
): DeepSeekChatRequest {
  return {
    model: options.model ?? request.model,
    messages: request.messages.map(toDeepSeekChatMessage),
    tools: request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    })),
    ...toDeepSeekThinkingOptions(request.reasoningEffort),
    stream: true
  };
}

// 把 DeepSeek Chat Completions 流映射为 OpenAI Responses stream events。
export async function* fromDeepSeekStream(
  stream: AsyncIterable<DeepSeekStreamChunk> | Iterable<DeepSeekStreamChunk>,
  options: { responseId?: string; model?: string } = {}
): AsyncIterable<ResponsesStreamEvent> {
  const pendingToolCalls = new Map<number, PendingToolCall>();
  const completedOutputItems: unknown[] = [];
  let responseId = options.responseId ?? 'resp_bridge';
  const model = options.model ?? 'bridge';
  let outputIndex = 0;
  let messageText = '';

  for await (const chunk of stream) {
    if (chunk.error?.message !== undefined) {
      yield { type: 'error', message: chunk.error.message };
      continue;
    }

    responseId = chunk.id ?? responseId;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (
      delta?.content !== undefined &&
      delta.content !== null &&
      delta.content.length > 0
    ) {
      messageText += delta.content;
      yield {
        type: 'response.output_text.delta',
        delta: delta.content,
        output_index: outputIndex,
        content_index: 0,
        item_id: `msg_${responseId}`
      };
    }

    for (const toolCall of delta?.tool_calls ?? []) {
      mergeToolCallChunk(pendingToolCalls, toolCall);
    }

    if (choice?.finish_reason === 'tool_calls') {
      for (const toolCall of pendingToolCalls.values()) {
        const item = {
          id: `fc_${toolCall.id}`,
          type: 'function_call' as const,
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.argumentsText,
          status: 'completed' as const
        };
        completedOutputItems.push(item);
        yield {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item
        };
        outputIndex += 1;
      }
      pendingToolCalls.clear();
      yield {
        type: 'response.completed',
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: buildCompletedOutput(responseId, messageText, completedOutputItems)
        }
      };
      messageText = '';
      completedOutputItems.length = 0;
      continue;
    }

    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      yield {
        type: 'response.completed',
        response: {
          id: responseId,
          model,
          status: 'completed',
          output: buildCompletedOutput(responseId, messageText, completedOutputItems)
        }
      };
      messageText = '';
      completedOutputItems.length = 0;
    }
  }
}

// Builds the terminal Responses output items consumed by the OpenAI Agents SDK.
function buildCompletedOutput(
  responseId: string,
  messageText: string,
  completedOutputItems: unknown[]
): unknown[] {
  return [
    ...(messageText.length === 0
      ? []
      : [
          {
            id: `msg_${responseId}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: messageText }]
          }
        ]),
    ...completedOutputItems
  ];
}

// 处理 bridge 的 HTTP routes，并保持 OpenAI-compatible JSON/SSE 形态。
async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResponsesBridgeOptions
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && path === '/health') {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (
    request.method === 'GET' &&
    (path === '/models' || path === '/v1/models')
  ) {
    const models = listModels(options);
    writeJson(response, 200, { object: 'list', data: models, models });
    return;
  }

  if (
    request.method === 'POST' &&
    (path === '/responses' || path === '/v1/responses')
  ) {
    await handleResponses(request, response, options);
    return;
  }

  writeJson(response, 404, { error: { message: 'Not found.' } });
}

// 执行一次 Responses 请求转发，并把上游 DeepSeek SSE 流写回客户端。
async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResponsesBridgeOptions
): Promise<void> {
  const apiKey = options.deepSeekApiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    writeJson(response, 500, {
      error: {
        message:
          'KODEKS_BRIDGE_DEEPSEEK_API_KEY or DEEPSEEK_API_KEY is required.'
      }
    });
    return;
  }

  const body = (await readJsonBody(request)) as ResponsesRequest;
  const coreRequest = toCoreRequest(body);
  const deepSeekRequest = toDeepSeekChatRequest(coreRequest, {
    model: options.deepSeekModel ?? DEFAULT_DEEPSEEK_MODEL
  });
  const upstream = await fetchDeepSeekStream(deepSeekRequest, apiKey, options);

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  for await (const event of fromDeepSeekStream(upstream, {
    model: coreRequest.model
  })) {
    response.write(toSseFrame(event));
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

// 调用 DeepSeek Chat Completions，并把 SSE 响应解析成 JSON chunk。
async function* fetchDeepSeekStream(
  payload: DeepSeekChatRequest,
  apiKey: string,
  options: ResponsesBridgeOptions
): AsyncIterable<DeepSeekStreamChunk> {
  const fetchImpl = options.fetch ?? fetch;
  const baseURL = trimTrailingSlash(
    options.deepSeekBaseURL ?? DEFAULT_DEEPSEEK_BASE_URL
  );
  const response = await fetchImpl(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': options.userAgent ?? 'kodeks-responses-bridge/0.1'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || response.body === null) {
    yield {
      error: {
        message: `DeepSeek request failed: ${response.status} ${response.statusText}`
      }
    };
    return;
  }

  yield* parseDeepSeekSse(response.body);
}

// 解析 OpenAI-compatible SSE，把每个 data JSON 转成 DeepSeek chunk。
async function* parseDeepSeekSse(
  body: ReadableStream<Uint8Array>
): AsyncIterable<DeepSeekStreamChunk> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice('data:'.length).trim();
      if (data === '[DONE]') {
        return;
      }
      yield JSON.parse(data) as DeepSeekStreamChunk;
    }
  }
}

// 把 Responses input 的 string 或数组形态统一成数组。
function normalizeInputItems(input: unknown): unknown[] {
  if (typeof input === 'string') {
    return [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: input }]
      }
    ];
  }

  return Array.isArray(input) ? input : [];
}

// 把单个 Responses input item 转换成 Core message。
function toCoreMessage(item: unknown): CoreMessage | null {
  if (!isRecord(item)) {
    return null;
  }

  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: readString(item.call_id) ?? readString(item.id) ?? '',
          name: readString(item.name) ?? '',
          argumentsText: readString(item.arguments) ?? '{}'
        }
      ]
    };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      content: readString(item.output) ?? '',
      toolCallId: readString(item.call_id) ?? ''
    };
  }

  const role = readCoreRole(item.role);
  if (role === null) {
    return null;
  }

  return {
    role,
    content: readContentText(item.content)
  };
}

// 把 Core message 转成 DeepSeek/OpenAI Chat Completions message。
function toDeepSeekChatMessage(message: CoreMessage): DeepSeekChatMessage {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId ?? ''
    };
  }

  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.length > 0 ? message.content : null,
      ...(message.toolCalls === undefined || message.toolCalls.length === 0
        ? {}
        : {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: toolCall.argumentsText
              }
            }))
          })
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

// 把 Kodeks reasoning effort 映射到 DeepSeek Thinking Mode。
function toDeepSeekThinkingOptions(
  reasoningEffort: ReasoningEffort
): Pick<DeepSeekChatRequest, 'thinking' | 'reasoning_effort'> {
  if (reasoningEffort === 'none') {
    return { thinking: { type: 'disabled' } };
  }

  return {
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffort === 'xhigh' ? 'max' : 'high'
  };
}

// 合并 Chat Completions tool_call delta 分片。
function mergeToolCallChunk(
  pendingToolCalls: Map<number, PendingToolCall>,
  chunk: DeepSeekToolCallDelta
): void {
  const index = chunk.index ?? 0;
  const current = pendingToolCalls.get(index) ?? {
    id: chunk.id ?? `call_${index}`,
    name: '',
    argumentsText: ''
  };
  pendingToolCalls.set(index, {
    id: chunk.id ?? current.id,
    name: chunk.function?.name ?? current.name,
    argumentsText: current.argumentsText + (chunk.function?.arguments ?? '')
  });
}

// 读取 HTTP JSON body。
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 写出 JSON 响应。
function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

// 把 stream event 序列化成 OpenAI-compatible SSE frame。
function toSseFrame(event: ResponsesStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// 列出 bridge 暴露的模型别名。
function listModels(
  options: ResponsesBridgeOptions
): Array<Record<string, string>> {
  return (options.modelAliases ?? DEFAULT_MODEL_ALIASES).map((model) => ({
    id: model,
    object: 'model',
    owned_by: 'kodeks'
  }));
}

// 从 mixed content blocks 中抽取文本。
function readContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }
      return (
        readString(block.text) ??
        readString(block.output_text) ??
        readString(block.input_text) ??
        ''
      );
    })
    .join('');
}

// 读取 Core 支持的 role。
function readCoreRole(value: unknown): CoreMessage['role'] | null {
  if (
    value === 'system' ||
    value === 'user' ||
    value === 'assistant' ||
    value === 'tool'
  ) {
    return value;
  }
  return null;
}

// 判断 unknown 是否是普通 record。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// 安全读取 string 字段。
function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// 移除 URL 末尾斜杠，避免拼接双斜杠。
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
