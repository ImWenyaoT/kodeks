import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadEnvConfig } from '@next/env';
import { runChatTurn, type AgentEvent } from '@kodeks/agent-runtime';
import {
  createModelClientFromEnv,
  resolveModelClientOptions,
  type ModelProviderOverride
} from '@kodeks/model';
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
};

type StreamKodeksChatOptions = {
  signal?: AbortSignal;
};

export { resolveModelClientOptions };

type KodeksUIDataParts = {
  session: { sessionId: string };
  status: { message: string; sessionId: string };
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
          runKodeksChatEvents(body, options.signal),
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
          runKodeksChatEvents(body, options.signal),
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
  const modelOptions = resolveModelClientOptions(
    process.env,
    body.reasoning_effort,
    body.provider
  );
  if (modelOptions === null) {
    const providerLabel = readProviderOverride(body) ?? 'auto';
    yield {
      type: 'error',
      message:
        `A model provider is required for ${providerLabel}. Set OPENAI_API_KEY for OpenAI Agents SDK + Responses, choose moonbridge for the local Responses bridge, or set DEEPSEEK_API_KEY for DeepSeek fallback.`,
      sessionId: sessionId ?? ''
    };
    return;
  }

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
    workspace: new WorkspaceService(workspaceRoot),
    database: getKodeksDatabase(),
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
function resolveWorkspaceRoot(): string {
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
