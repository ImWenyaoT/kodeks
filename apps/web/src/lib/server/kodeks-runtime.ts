import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';
import {
  runChatTurn,
  type AgentEvent,
  type SelectedWorkspaceFileContext
} from '@kodeks/agent-runtime';
import {
  createModelClientFromEnv,
  resolveModelClientOptions,
  type ModelClientOptions,
  type ModelProviderOverride
} from '@kodeks/model';
import { createBridgeServer } from '@kodeks/responses-bridge';
import { KodeksDatabase } from '@kodeks/storage';
import { WorkspaceService } from '@kodeks/workspace';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamWriter
} from 'ai';

import type { ChatMode } from '@/lib/chat-stream';

type ChatStreamRequest = {
  input?: unknown;
  session_id?: unknown;
  mode?: unknown;
  reasoning_effort?: unknown;
  provider?: unknown;
  selected_files?: unknown;
};

type StreamKodeksChatOptions = {
  signal?: AbortSignal;
};

export { resolveModelClientOptions };

type KodeksUIDataParts = {
  session: { sessionId: string };
  status: { message: string; sessionId: string };
  error: { message: string; code?: string; sessionId: string };
  memory: {
    memoryIds: string[];
    layers?: Record<string, number>;
    sessionId: string;
  };
  plan: { action: 'created' | 'recovered'; plan: unknown; sessionId: string };
  approval: {
    approvalId: string;
    toolCallId: string;
    reason: string;
    sessionId: string;
  };
  subagent: {
    runId: string;
    agent?: 'explore';
    summary?: string;
    sessionId: string;
  };
  completed: { responseId: string; sessionId: string };
};

type KodeksUIMessage = UIMessage<{ sessionId?: string }, KodeksUIDataParts>;

let database: KodeksDatabase | null = null;
let workspaceEnvLoaded = false;
let managedBridgeServer: { origin: string; server: Server } | null = null;
let managedBridgeStartPromise: Promise<void> | null = null;

const MAX_SELECTED_FILES = 8;
const MAX_SELECTED_FILE_CHARS = 12_000;
const MAX_SELECTED_FILES_TOTAL_CHARS = 36_000;

// Streams one chat turn through the TypeScript runtime as SSE bytes.
export function streamKodeksChat(
  body: ChatStreamRequest,
  options: StreamKodeksChatOptions = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of abortableAgentEvents(
          visibleRuntimeEvents(body, options.signal),
          options.signal
        )) {
          controller.enqueue(encoder.encode(toSseFrame(event)));
        }
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        const fallbackSessionId = readSessionId(body) ?? '';
        controller.enqueue(
          encoder.encode(
            toSseFrame({
              type: 'error',
              message: error instanceof Error ? error.message : String(error),
              sessionId: fallbackSessionId
            })
          )
        );
      } finally {
        controller.close();
      }
    }
  });
}

// Creates a Vercel AI SDK UIMessage stream response for SDK-native clients.
export function createKodeksUIMessageResponse(
  body: ChatStreamRequest,
  options: StreamKodeksChatOptions = {}
): Response {
  const stream = createUIMessageStream<KodeksUIMessage>({
    execute: async ({ writer }) => {
      await writeKodeksUIMessageChunks(
        writer,
        abortableAgentEvents(
          visibleRuntimeEvents(body, options.signal),
          options.signal
        )
      );
    },
    onError: (error) => (error instanceof Error ? error.message : String(error))
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      'Cache-Control': 'no-cache, no-transform'
    }
  });
}

// Stops consuming runtime events once the HTTP client disconnects.
async function* abortableAgentEvents(
  events: AsyncIterable<AgentEvent>,
  signal?: AbortSignal
): AsyncIterable<AgentEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let removeAbortListener: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? null
      : new Promise<'aborted'>((resolve) => {
          if (signal.aborted) {
            resolve('aborted');
            return;
          }
          const onAbort = () => resolve('aborted');
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener('abort', onAbort);
        });

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }

      const next =
        abortPromise === null
          ? await iterator.next()
          : await Promise.race([iterator.next(), abortPromise]);
      if (next === 'aborted' || next.done) {
        return;
      }

      yield next.value;
    }
  } finally {
    removeAbortListener?.();
    await iterator.return?.();
  }
}

// 把后端异常归一化成可流式展示的 runtime error 事件。
async function* visibleRuntimeEvents(
  body: ChatStreamRequest,
  signal?: AbortSignal
): AsyncIterable<AgentEvent> {
  try {
    yield* runKodeksChatEvents(body, signal);
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    yield toRuntimeErrorEvent(error, readSessionId(body) ?? '');
  }
}

// Runs the shared Kodeks chat pipeline used by both SSE and Vercel AI SDK routes.
async function* runKodeksChatEvents(
  body: ChatStreamRequest,
  signal?: AbortSignal
): AsyncIterable<AgentEvent> {
  loadWorkspaceEnv();

  const sessionId = readSessionId(body);
  const input = typeof body.input === 'string' ? body.input : '';
  const mode: ChatMode = body.mode === 'plan' ? 'plan' : 'act';

  if (input.trim().length === 0) {
    yield {
      type: 'error',
      message: 'Input is required.',
      sessionId: sessionId ?? ''
    };
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const workspace = new WorkspaceService(workspaceRoot);
  const selectedFiles = await readSelectedWorkspaceFiles(body, workspace);
  const modelOptions = resolveModelClientOptions(
    process.env,
    body.reasoning_effort,
    body.provider
  );
  if (modelOptions === null) {
    const providerLabel = readProviderOverride(body) ?? 'auto';
    yield {
      type: 'error',
      message: `A model provider is required for ${providerLabel}. Set OPENAI_API_KEY for OpenAI Agents SDK + Responses, choose moonbridge for the local Responses bridge, or set DEEPSEEK_API_KEY for DeepSeek fallback.`,
      code: 'model_provider_missing',
      sessionId: sessionId ?? ''
    };
    return;
  }
  await ensureManagedBridgeServer(process.env, modelOptions);

  const model =
    modelOptions.provider === 'deepseek'
      ? createModelClientFromEnv(
          process.env,
          body.reasoning_effort,
          body.provider
        )
      : null;
  yield* runChatTurn({
    input,
    sessionId,
    mode,
    workspace,
    database: getKodeksDatabase(),
    selectedFiles,
    ...(modelOptions.provider === 'deepseek'
      ? { model: model ?? undefined }
      : {
          agents: {
            provider: modelOptions.provider,
            apiKey: modelOptions.apiKey,
            baseURL: modelOptions.baseURL,
            model: modelOptions.model,
            reasoningEffort: modelOptions.reasoningEffort,
            signal
          }
        })
  });
}

// 读取并截断用户显式选择的 workspace 文件，避免把未授权路径或过大内容注入模型。
async function readSelectedWorkspaceFiles(
  body: ChatStreamRequest,
  workspace: WorkspaceService
): Promise<SelectedWorkspaceFileContext[]> {
  if (!Array.isArray(body.selected_files)) {
    return [];
  }
  const selectedPaths = [
    ...new Set(
      body.selected_files.flatMap((value) =>
        typeof value === 'string' && value.trim().length > 0
          ? [value.trim()]
          : []
      )
    )
  ].slice(0, MAX_SELECTED_FILES);
  const files: SelectedWorkspaceFileContext[] = [];
  let remainingCharacters = MAX_SELECTED_FILES_TOTAL_CHARS;

  for (const path of selectedPaths) {
    if (remainingCharacters <= 0) {
      files.push({
        path,
        error: 'Selected file context budget exhausted.'
      });
      continue;
    }
    try {
      const content = await workspace.readFile(path);
      const budget = Math.min(MAX_SELECTED_FILE_CHARS, remainingCharacters);
      const truncated = content.length > budget;
      files.push({
        path,
        content: truncated ? content.slice(0, budget) : content,
        truncated
      });
      remainingCharacters -= Math.min(content.length, budget);
    } catch (error) {
      files.push({
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return files;
}

// 创建带稳定 code 的后端错误事件，供 SSE 和 UIMessage stream 共用。
function toRuntimeErrorEvent(error: unknown, sessionId: string): AgentEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'error',
    message,
    code: readRuntimeErrorCode(error, message),
    sessionId
  };
}

// 根据错误形态给 UI 提供可分组的诊断 code。
function readRuntimeErrorCode(error: unknown, message: string): string {
  if (isAddressInUseError(error) || message.includes('MoonBridge')) {
    return 'moonbridge_start_failed';
  }
  return 'runtime_error';
}

// Ensures the local MoonBridge Responses bridge exists before the Agents SDK connects to it.
async function ensureManagedBridgeServer(
  env: NodeJS.ProcessEnv,
  modelOptions: ModelClientOptions
): Promise<void> {
  if (
    modelOptions.provider !== 'bridge' &&
    modelOptions.provider !== 'moonbridge'
  ) {
    return;
  }

  const baseURL = readManagedBridgeBaseURL(modelOptions.baseURL);
  if (baseURL === null) {
    return;
  }
  const origin = baseURL.origin;
  if (await isManagedBridgeHealthy(origin)) {
    return;
  }
  if (managedBridgeServer?.origin === origin) {
    return;
  }
  if (managedBridgeStartPromise !== null) {
    await managedBridgeStartPromise;
    return;
  }

  managedBridgeStartPromise = startManagedBridgeServer(env, origin, baseURL)
    .finally(() => {
      managedBridgeStartPromise = null;
    });
  await managedBridgeStartPromise;
}

// Starts the embedded Responses bridge for local MoonBridge provider requests.
async function startManagedBridgeServer(
  env: NodeJS.ProcessEnv,
  origin: string,
  baseURL: URL
): Promise<void> {
  const server = createBridgeServer({
    deepSeekApiKey:
      env.KODEKS_BRIDGE_DEEPSEEK_API_KEY ??
      env.MOONBRIDGE_DEEPSEEK_API_KEY ??
      env.DEEPSEEK_API_KEY,
    deepSeekBaseURL: env.KODEKS_BRIDGE_DEEPSEEK_BASE_URL ?? env.DEEPSEEK_BASE_URL,
    deepSeekModel:
      env.KODEKS_BRIDGE_DEEPSEEK_MODEL ??
      env.MOONBRIDGE_DEEPSEEK_MODEL ??
      env.DEEPSEEK_MODEL,
    modelAliases: [
      env.KODEKS_BRIDGE_MODEL ?? env.MOONBRIDGE_MODEL ?? 'bridge',
      'moonbridge'
    ],
    userAgent: 'kodeks-web-moonbridge/0.1'
  });
  const hostname = baseURL.hostname || '127.0.0.1';
  const port = Number(baseURL.port || '38440');

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', (error) => {
      rejectListen(error);
    });
    server.listen(port, hostname, () => {
      managedBridgeServer = { origin, server };
      resolveListen();
    });
  }).catch((error: unknown) => {
    server.close();
    if (isAddressInUseError(error)) {
      throw new Error(
        `MoonBridge could not start because ${origin} is already in use but did not respond to /health.`
      );
    }
    throw error;
  });
}

// Reads the bridge URL only for local HTTP endpoints that the web runtime can manage.
function readManagedBridgeBaseURL(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') {
    return null;
  }
  if (
    url.hostname !== '127.0.0.1' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '::1'
  ) {
    return null;
  }
  return url;
}

// Checks whether a local bridge is already running before starting an embedded one.
async function isManagedBridgeHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Detects Node listen errors for ports that are occupied by non-bridge processes.
function isAddressInUseError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EADDRINUSE'
  );
}

// Loads env files from the monorepo workspace root once for nested Next.js apps.
function loadWorkspaceEnv(): void {
  if (workspaceEnvLoaded) {
    return;
  }

  if (process.env.NODE_ENV !== 'test') {
    loadEnvConfig(
      resolveWorkspaceRoot(),
      process.env.NODE_ENV !== 'production',
      undefined,
      true
    );
  }
  workspaceEnvLoaded = true;
}

// Reads a normalized session id from loose HTTP request payloads.
function readSessionId(body: ChatStreamRequest): string | null {
  return typeof body.session_id === 'string' && body.session_id.trim()
    ? body.session_id.trim()
    : null;
}

// Reads the optional per-session model provider override from loose HTTP payloads.
function readProviderOverride(
  body: ChatStreamRequest
): ModelProviderOverride | null {
  if (
    body.provider === 'bridge' ||
    body.provider === 'openai' ||
    body.provider === 'moonbridge' ||
    body.provider === 'deepseek'
  ) {
    return body.provider;
  }

  return null;
}

// Returns the singleton SQLite database used by local Next.js route handlers.
export function getKodeksDatabase(): KodeksDatabase {
  if (database !== null) {
    return database;
  }
  const dbPath =
    process.env.KODEKS_DB_PATH ??
    join(resolveWorkspaceRoot(), '.kodeks', 'kodeks.sqlite3');
  mkdirSync(dirname(dbPath), { recursive: true });
  database = new KodeksDatabase(dbPath);
  return database;
}

// Returns a workspace service bound to the current authorized project root.
export function getKodeksWorkspace(): WorkspaceService {
  return new WorkspaceService(resolveWorkspaceRoot());
}

// Resolves the workspace root for local development and deployed route handlers.
export function resolveWorkspaceRoot(): string {
  if (process.env.KODEKS_WORKSPACE_ROOT) {
    return resolve(process.env.KODEKS_WORKSPACE_ROOT);
  }
  return join(/* turbopackIgnore: true */ process.cwd(), '../..');
}

// Writes internal agent events as Vercel AI SDK UIMessage chunks.
async function writeKodeksUIMessageChunks(
  writer: UIMessageStreamWriter<KodeksUIMessage>,
  events: AsyncIterable<AgentEvent>
): Promise<void> {
  const textId = `txt_${crypto.randomUUID().replaceAll('-', '')}`;
  let textStarted = false;

  for await (const event of events) {
    if (event.type === 'text_delta') {
      if (!textStarted) {
        writer.write({ type: 'text-start', id: textId });
        textStarted = true;
      }
      writer.write({ type: 'text-delta', id: textId, delta: event.text });
      continue;
    }

    if (event.type === 'session_created') {
      writer.write({
        type: 'data-session',
        data: { sessionId: event.sessionId },
        transient: true
      });
      continue;
    }

    if (event.type === 'assistant_status') {
      writer.write({
        type: 'data-status',
        data: { message: event.message, sessionId: event.sessionId },
        transient: true
      });
      continue;
    }

    if (event.type === 'tool_call') {
      writer.write({
        type: 'tool-input-available',
        toolCallId: event.id,
        toolName: event.name,
        input: event.args
      });
      continue;
    }

    if (event.type === 'tool_result') {
      writer.write({
        type: 'tool-output-available',
        toolCallId: event.id,
        output: event.output
      });
      continue;
    }

    if (event.type === 'approval_required') {
      writer.write({
        type: 'tool-approval-request',
        approvalId: event.approvalId,
        toolCallId: event.toolCallId
      });
      writer.write({
        type: 'data-approval',
        data: {
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          reason: event.reason,
          sessionId: event.sessionId
        },
        transient: true
      });
      continue;
    }

    if (event.type === 'memory_recalled') {
      writer.write({
        type: 'data-memory',
        data: {
          memoryIds: event.memoryIds,
          layers: event.layers,
          sessionId: event.sessionId
        }
      });
      continue;
    }

    if (event.type === 'plan_artifact') {
      writer.write({
        type: 'data-plan',
        data: {
          action: event.action,
          plan: event.plan,
          sessionId: event.sessionId
        },
        transient: event.action === 'recovered'
      });
      continue;
    }

    if (event.type === 'subagent_started') {
      writer.write({
        type: 'data-subagent',
        data: {
          runId: event.runId,
          agent: event.agent,
          sessionId: event.sessionId
        },
        transient: true
      });
      continue;
    }

    if (event.type === 'subagent_completed') {
      writer.write({
        type: 'data-subagent',
        data: {
          runId: event.runId,
          summary: event.summary,
          sessionId: event.sessionId
        }
      });
      continue;
    }

    if (event.type === 'response_completed') {
      if (textStarted) {
        writer.write({ type: 'text-end', id: textId });
      }
      writer.write({
        type: 'data-completed',
        data: { responseId: event.responseId, sessionId: event.sessionId }
      });
      continue;
    }

    if (textStarted) {
      writer.write({ type: 'text-end', id: textId });
      textStarted = false;
    }
    writer.write({
      type: 'data-error',
      data: {
        message: event.message,
        code: event.code,
        sessionId: event.sessionId
      }
    });
    writer.write({ type: 'error', errorText: event.message });
  }
}

// Converts product agent events into the existing frontend SSE wire format.
function toSseFrame(event: AgentEvent): string {
  const payload = toWirePayload(event);
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// Converts camelCase runtime events into snake_case transport payloads.
function toWirePayload(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'session_created') {
    return { type: 'session_created', session_id: event.sessionId };
  }
  if (event.type === 'assistant_status') {
    return {
      type: 'assistant_status',
      message: event.message,
      session_id: event.sessionId
    };
  }
  if (event.type === 'text_delta') {
    return {
      type: 'text_delta',
      delta: event.text,
      session_id: event.sessionId
    };
  }
  if (event.type === 'tool_call') {
    return {
      type: 'tool_call',
      tool_call_id: event.id,
      tool_name: event.name,
      tool_arguments: event.args,
      session_id: event.sessionId
    };
  }
  if (event.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_call_id: event.id,
      tool_name: event.name,
      tool_output: event.output,
      tool_status: event.status,
      session_id: event.sessionId
    };
  }
  if (event.type === 'approval_required') {
    return {
      type: 'approval_required',
      approval_id: event.approvalId,
      tool_call_id: event.toolCallId,
      message: event.reason,
      session_id: event.sessionId
    };
  }
  if (event.type === 'memory_recalled') {
    return {
      type: 'memory_recalled',
      memory_ids: event.memoryIds,
      memory_layers: event.layers,
      session_id: event.sessionId
    };
  }
  if (event.type === 'plan_artifact') {
    return {
      type: 'plan_artifact',
      action: event.action,
      plan: event.plan,
      session_id: event.sessionId
    };
  }
  if (event.type === 'subagent_started') {
    return {
      type: 'subagent_started',
      run_id: event.runId,
      agent: event.agent,
      session_id: event.sessionId
    };
  }
  if (event.type === 'subagent_completed') {
    return {
      type: 'subagent_completed',
      run_id: event.runId,
      summary: event.summary,
      session_id: event.sessionId
    };
  }
  if (event.type === 'response_completed') {
    return {
      type: 'response_completed',
      response_id: event.responseId,
      session_id: event.sessionId
    };
  }
  return {
    type: 'error',
    message: event.message,
    code: event.code,
    session_id: event.sessionId
  };
}
