import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadEnvConfig } from "@next/env";
import {
  runChatTurn,
  type AgentEvent,
  type SelectedWorkspaceFileContext,
} from "@kodeks/agent-runtime";
import {
  DEFAULT_CHAT_COMPLETIONS_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  loadConfiguredModelCatalog,
  loadModelRuntimeEnv,
  ModelConfigurationError,
  resolveModelClientOptions,
  type ConfiguredModelCatalog,
  type ModelClientOptions,
  type ModelProviderOverride,
  type RuntimeEnv,
} from "@kodeks/model";
import { createBridgeServer } from "@kodeks/responses-bridge";
import { KodeksDatabase } from "@kodeks/storage";
import { WorkspaceService } from "@kodeks/workspace";

import type { ChatMode } from "@/lib/chat-stream";

type ChatStreamRequest = {
  input?: unknown;
  session_id?: unknown;
  mode?: unknown;
  reasoning_effort?: unknown;
  provider?: unknown;
  model?: unknown;
  selected_files?: unknown;
};

type StreamKodeksChatOptions = {
  signal?: AbortSignal;
};

export { resolveModelClientOptions };

// Lists configured provider/model refs from the user config for the frontend selector.
export function listConfiguredModelCatalog(): ConfiguredModelCatalog {
  loadWorkspaceEnv();
  return loadConfiguredModelCatalog(process.env);
}

// 关闭当前由 web runtime 托管的 MoonBridge server，供测试或运行时重置使用。
export async function stopManagedBridgeServer(): Promise<void> {
  const current = managedBridgeServer;
  managedBridgeServer = null;
  managedBridgeStartPromise = null;
  if (current === null) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    current.server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

// 重置 server-side runtime 单例，避免测试间复用旧 bridge 或 SQLite 连接。
export async function resetKodeksRuntimeForTest(): Promise<void> {
  await stopManagedBridgeServer();
  database?.close();
  database = null;
}

export type MoonBridgePreflightStatus =
  | "ready"
  | "unavailable"
  | "not_required";

export type MoonBridgePreflightResult = {
  status: MoonBridgePreflightStatus;
  provider: ModelProviderOverride | "auto";
  resolvedProvider?: ModelProviderOverride;
  code?: string;
  reason?: string;
  bridgeBaseURL?: string;
  bridgeModel?: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
  checkedAt: string;
};

let database: KodeksDatabase | null = null;
let workspaceEnvLoaded = false;
type ManagedBridgeServer = {
  requestedOrigin: string;
  origin: string;
  baseURL: string;
  upstreamSignature: string;
  server: Server;
};

type ManagedBridgeResolution = {
  requestedOrigin: string;
  origin: string;
  baseURL: string;
  upstreamSignature: string;
  recovered: boolean;
};

type ManagedBridgeModelOptions = ModelClientOptions & {
  provider: "moonbridge";
  baseURL: string;
};

let managedBridgeServer: ManagedBridgeServer | null = null;
let managedBridgeStartPromise: Promise<ManagedBridgeResolution> | null = null;

const MAX_SELECTED_FILES = 8;
const MAX_SELECTED_FILE_CHARS = 12_000;
const MAX_SELECTED_FILES_TOTAL_CHARS = 36_000;

// Streams one chat turn through the TypeScript runtime as SSE bytes.
export function streamKodeksChat(
  body: ChatStreamRequest,
  options: StreamKodeksChatOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of abortableAgentEvents(
          visibleRuntimeEvents(body, options.signal),
          options.signal,
        )) {
          controller.enqueue(encoder.encode(toSseFrame(event)));
        }
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        const fallbackSessionId = readSessionId(body) ?? "";
        controller.enqueue(
          encoder.encode(
            toSseFrame({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
              sessionId: fallbackSessionId,
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });
}

// 预检当前 provider 的 MoonBridge 可用性，供调试面板在页面打开时展示。
export async function inspectMoonBridgePreflight(
  body: Pick<ChatStreamRequest, "provider" | "model"> = {},
): Promise<MoonBridgePreflightResult> {
  loadWorkspaceEnv();

  const checkedAt = new Date().toISOString();
  let requestedProvider: ModelProviderOverride | "auto";
  try {
    requestedProvider = readProviderOverride(body) ?? "auto";
  } catch (error) {
    return {
      status: "unavailable",
      provider: "auto",
      code: readRuntimeErrorCode(
        error,
        error instanceof Error ? error.message : String(error),
      ),
      reason: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
  const modelEnv = loadModelRuntimeEnv(
    process.env,
    readRequestedModelRef(body),
  );
  let modelOptions: ModelClientOptions | null;
  try {
    modelOptions = resolveModelClientOptions(modelEnv, undefined, body.provider);
  } catch (error) {
    return {
      status: "unavailable",
      provider: requestedProvider,
      code: readRuntimeErrorCode(
        error,
        error instanceof Error ? error.message : String(error),
      ),
      reason: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
  if (modelOptions === null) {
    return {
      status: "unavailable",
      provider: requestedProvider,
      code: "model_provider_missing",
      reason:
        "No model provider is configured. Set KODEKS_CHAT_COMPLETIONS_* for DeepSeek-first MoonBridge or KODEKS_RESPONSES_* / OPENAI_* for OpenAI fallback.",
      checkedAt,
    };
  }

  if (modelOptions.provider !== "moonbridge") {
    return {
      status: "not_required",
      provider: requestedProvider,
      resolvedProvider: modelOptions.provider,
      bridgeModel: modelOptions.model,
      checkedAt,
    };
  }

  const bridgeBaseURL = readManagedBridgeBaseURL(modelOptions.baseURL);
  const upstreamConfig = readChatCompletionsPreflightConfig(modelEnv);
  const baseResult = {
    provider: requestedProvider,
    resolvedProvider: modelOptions.provider,
    bridgeBaseURL: modelOptions.baseURL,
    bridgeModel: modelOptions.model,
    upstreamBaseURL: upstreamConfig.baseURL,
    upstreamModel: upstreamConfig.model,
    checkedAt,
  } satisfies Omit<MoonBridgePreflightResult, "status">;

  if (bridgeBaseURL === null) {
    return {
      ...baseResult,
      status: "unavailable",
      code: "moonbridge_non_local",
      reason:
        "MoonBridge can only be managed from the web runtime when KODEKS_BRIDGE_BASE_URL is a local http URL.",
    };
  }

  if (upstreamConfig.missing.length > 0) {
    return {
      ...baseResult,
      status: "unavailable",
      code: "moonbridge_upstream_missing",
      reason: `Missing upstream Chat Completions configuration: ${upstreamConfig.missing.join(", ")}.`,
    };
  }

  let bridgeResolution: ManagedBridgeResolution;
  try {
    bridgeResolution = await ensureManagedBridgeServer(modelEnv, modelOptions);
  } catch (error) {
    return {
      ...baseResult,
      status: "unavailable",
      code: readRuntimeErrorCode(
        error,
        error instanceof Error ? error.message : String(error),
      ),
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const isHealthy = await isManagedBridgeHealthy(bridgeResolution.origin);
  if (!isHealthy) {
    return {
      ...baseResult,
      bridgeBaseURL: bridgeResolution.baseURL,
      status: "unavailable",
      code: "moonbridge_health_failed",
      reason: `MoonBridge did not respond with a healthy /health result at ${bridgeResolution.origin}.`,
    };
  }

  return {
    ...baseResult,
    bridgeBaseURL: bridgeResolution.baseURL,
    status: "ready",
    ...(bridgeResolution.recovered
      ? {
          code: "moonbridge_port_recovered",
          reason: `MoonBridge recovered from an occupied port at ${bridgeResolution.requestedOrigin} and is running at ${bridgeResolution.origin}.`,
        }
      : {}),
  };
}

// Stops consuming runtime events once the HTTP client disconnects.
async function* abortableAgentEvents(
  events: AsyncIterable<AgentEvent>,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let removeAbortListener: (() => void) | undefined;
  const abortPromise =
    signal === undefined
      ? null
      : new Promise<"aborted">((resolve) => {
          if (signal.aborted) {
            resolve("aborted");
            return;
          }
          const onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", onAbort);
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
      if (next === "aborted" || next.done) {
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
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  try {
    yield* runKodeksChatEvents(body, signal);
  } catch (error) {
    if (signal?.aborted) {
      return;
    }
    yield toRuntimeErrorEvent(error, readSessionId(body) ?? "");
  }
}

// Runs the shared Kodeks chat pipeline used by the SSE route.
async function* runKodeksChatEvents(
  body: ChatStreamRequest,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent> {
  loadWorkspaceEnv();

  const sessionId = readSessionId(body);
  const input = typeof body.input === "string" ? body.input : "";
  const mode: ChatMode = body.mode === "plan" ? "plan" : "act";

  if (input.trim().length === 0) {
    yield {
      type: "error",
      message: "Input is required.",
      sessionId: sessionId ?? "",
    };
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const workspace = new WorkspaceService(workspaceRoot);
  const selectedFiles = await readSelectedWorkspaceFiles(body, workspace);
  const modelEnv = loadModelRuntimeEnv(
    process.env,
    readRequestedModelRef(body),
  );
  const modelOptions = resolveModelClientOptions(
    modelEnv,
    body.reasoning_effort,
    body.provider,
  );
  if (modelOptions === null) {
    const providerLabel = readProviderOverride(body) ?? "auto";
    yield {
      type: "error",
      message: `A model provider is required for ${providerLabel}. Configure KODEKS_CHAT_COMPLETIONS_* for DeepSeek-first MoonBridge, or configure KODEKS_RESPONSES_* / OPENAI_* for OpenAI fallback.`,
      code: "model_provider_missing",
      sessionId: sessionId ?? "",
    };
    return;
  }
  let resolvedModelOptions = modelOptions;
  if (modelOptions.provider === "moonbridge") {
    const upstreamConfig = readChatCompletionsPreflightConfig(modelEnv);
    if (upstreamConfig.missing.length > 0) {
      yield {
        type: "error",
        message: `Missing upstream Chat Completions configuration: ${upstreamConfig.missing.join(", ")}.`,
        code: "moonbridge_upstream_missing",
        sessionId: sessionId ?? "",
      };
      return;
    }
    const bridgeResolution = await ensureManagedBridgeServer(
      modelEnv,
      modelOptions,
    );
    resolvedModelOptions = {
      ...modelOptions,
      baseURL: bridgeResolution.baseURL,
    };
  }

  yield* runChatTurn({
    input,
    sessionId,
    mode,
    workspace,
    database: getKodeksDatabase(),
    selectedFiles,
    environment: modelEnv,
    agents: {
      provider: resolvedModelOptions.provider,
      apiKey: resolvedModelOptions.apiKey,
      baseURL: resolvedModelOptions.baseURL,
      model: resolvedModelOptions.model,
      reasoningEffort: resolvedModelOptions.reasoningEffort,
      signal,
    },
  });
}

// 读取并截断用户显式选择的 workspace 文件，避免把未授权路径或过大内容注入模型。
async function readSelectedWorkspaceFiles(
  body: ChatStreamRequest,
  workspace: WorkspaceService,
): Promise<SelectedWorkspaceFileContext[]> {
  if (!Array.isArray(body.selected_files)) {
    return [];
  }
  const selectedPaths = [
    ...new Set(
      body.selected_files.flatMap((value) =>
        typeof value === "string" && value.trim().length > 0
          ? [value.trim()]
          : [],
      ),
    ),
  ].slice(0, MAX_SELECTED_FILES);
  const files: SelectedWorkspaceFileContext[] = [];
  let remainingCharacters = MAX_SELECTED_FILES_TOTAL_CHARS;

  for (const path of selectedPaths) {
    if (remainingCharacters <= 0) {
      files.push({
        path,
        error: "Selected file context budget exhausted.",
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
        truncated,
      });
      remainingCharacters -= Math.min(content.length, budget);
    } catch (error) {
      files.push({
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return files;
}

// 创建带稳定 code 的后端错误事件，供 SSE stream 使用。
function toRuntimeErrorEvent(error: unknown, sessionId: string): AgentEvent {
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "error",
    message,
    code: readRuntimeErrorCode(error, message),
    sessionId,
  };
}

// 根据错误形态给 UI 提供可分组的诊断 code。
function readRuntimeErrorCode(error: unknown, message: string): string {
  if (error instanceof ModelConfigurationError) {
    return error.code;
  }
  if (isAddressInUseError(error) || message.includes("MoonBridge")) {
    return "moonbridge_start_failed";
  }
  return "runtime_error";
}

// 确保本地 MoonBridge 已就绪，并返回 agent 应该实际连接的模型配置。
async function ensureManagedBridgeServer(
  env: RuntimeEnv,
  modelOptions: ManagedBridgeModelOptions,
): Promise<ManagedBridgeResolution> {
  const baseURL = readManagedBridgeBaseURL(modelOptions.baseURL);
  if (baseURL === null) {
    return {
      requestedOrigin: "",
      origin: "",
      baseURL: modelOptions.baseURL,
      upstreamSignature: "",
      recovered: false,
    };
  }
  const origin = baseURL.origin;
  const upstreamSignature = readManagedBridgeUpstreamSignature(env);
  if (
    managedBridgeServer?.requestedOrigin === origin &&
    managedBridgeServer.upstreamSignature === upstreamSignature &&
    (await isManagedBridgeHealthy(managedBridgeServer.origin))
  ) {
    return {
      requestedOrigin: origin,
      origin: managedBridgeServer.origin,
      baseURL: managedBridgeServer.baseURL,
      upstreamSignature,
      recovered: managedBridgeServer.origin !== origin,
    };
  }
  if (managedBridgeServer?.requestedOrigin === origin) {
    await stopManagedBridgeServer();
  }
  if (await isManagedBridgeHealthy(origin)) {
    return {
      requestedOrigin: origin,
      origin,
      baseURL: modelOptions.baseURL,
      upstreamSignature,
      recovered: false,
    };
  }
  if (managedBridgeStartPromise !== null) {
    const resolution = await managedBridgeStartPromise;
    if (
      resolution.requestedOrigin === origin &&
      resolution.upstreamSignature === upstreamSignature
    ) {
      return resolution;
    }
  }

  managedBridgeStartPromise = startManagedBridgeServer(
    env,
    origin,
    baseURL,
  ).finally(() => {
    managedBridgeStartPromise = null;
  });
  const resolution = await managedBridgeStartPromise;
  return resolution;
}

// 启动内嵌 Responses bridge；如果目标端口被非 bridge 服务占用，则安全重试动态端口。
async function startManagedBridgeServer(
  env: RuntimeEnv,
  origin: string,
  baseURL: URL,
): Promise<ManagedBridgeResolution> {
  const upstreamSignature = readManagedBridgeUpstreamSignature(env);
  const bridgeOptions = {
    chatCompletionsApiKey: readChatCompletionsApiKey(env),
    chatCompletionsBaseURL: readChatCompletionsBaseURL(env),
    chatCompletionsModel: readChatCompletionsModel(env),
    modelAliases: [env.KODEKS_BRIDGE_MODEL ?? "bridge", "moonbridge"],
    userAgent: "kodeks-web-moonbridge/0.1",
  };
  const hostname = baseURL.hostname || "127.0.0.1";
  const port = Number(baseURL.port || "38440");
  const requested = await listenForManagedBridge(
    createBridgeServer(bridgeOptions),
    hostname,
    port,
    baseURL,
    origin,
    upstreamSignature,
  ).catch(async (error: unknown) => {
    if (!isAddressInUseError(error)) {
      throw error;
    }
    return listenForManagedBridge(
      createBridgeServer(bridgeOptions),
      hostname,
      0,
      baseURL,
      origin,
      upstreamSignature,
    ).catch((retryError: unknown) => {
      throw new Error(
        `MoonBridge could not start because ${origin} is already in use and the automatic retry failed: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      );
    });
  });

  await stopManagedBridgeServer();
  managedBridgeServer = requested;
  return {
    requestedOrigin: requested.requestedOrigin,
    origin: requested.origin,
    baseURL: requested.baseURL,
    upstreamSignature,
    recovered: requested.origin !== requested.requestedOrigin,
  };
}

// 监听一个 bridge server，并返回客户端应该使用的最终 base URL。
async function listenForManagedBridge(
  server: Server,
  hostname: string,
  port: number,
  baseURL: URL,
  requestedOrigin: string,
  upstreamSignature: string,
): Promise<ManagedBridgeServer> {
  return new Promise<ManagedBridgeServer>((resolveListen, rejectListen) => {
    server.once("error", (error) => {
      server.close();
      rejectListen(error);
    });
    server.listen(port, hostname, () => {
      const address = server.address();
      const actualPort =
        address !== null && typeof address === "object" ? address.port : port;
      const effectiveBaseURL = createManagedBridgeBaseURL(baseURL, actualPort);
      resolveListen({
        requestedOrigin,
        origin: new URL(effectiveBaseURL).origin,
        baseURL: effectiveBaseURL,
        upstreamSignature,
        server,
      });
    });
  });
}

// 只改写配置 URL 的端口，保留 host 和 /v1 等路径。
function createManagedBridgeBaseURL(baseURL: URL, port: number): string {
  const next = new URL(baseURL.toString());
  next.port = String(port);
  return next.toString().replace(/\/$/, "");
}

// 记录托管 bridge 的上游配置指纹；用户切换模型或 endpoint 时需要重启 bridge。
function readManagedBridgeUpstreamSignature(env: RuntimeEnv): string {
  return JSON.stringify({
    apiKey: readChatCompletionsApiKey(env) ?? "",
    baseURL: readChatCompletionsBaseURL(env),
    model: readChatCompletionsModel(env),
  });
}

// 读取 MoonBridge 上游 Chat Completions key；本地 endpoint 可使用占位 key。
function readChatCompletionsApiKey(env: RuntimeEnv): string | undefined {
  const localBaseURL = isLocalHttpURL(readChatCompletionsBaseURL(env));
  return (
    env.KODEKS_CHAT_COMPLETIONS_API_KEY ??
    (localBaseURL ? "not-needed" : undefined)
  );
}

// 读取标准 Chat Completions base URL，DeepSeek-first 场景默认走官方 OpenAI-format 地址。
function readChatCompletionsBaseURL(env: RuntimeEnv): string {
  return env.KODEKS_CHAT_COMPLETIONS_BASE_URL ?? DEFAULT_CHAT_COMPLETIONS_BASE_URL;
}

// 读取标准 Chat Completions 模型，默认使用当前 DeepSeek 官方 V4 Flash ID。
function readChatCompletionsModel(env: RuntimeEnv): string {
  return env.KODEKS_CHAT_COMPLETIONS_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
}

// 判断 endpoint 是否是本机无鉴权开发服务；只有这种场景才自动补占位 key。
function isLocalHttpURL(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1")
    );
  } catch {
    return false;
  }
}

// 读取 MoonBridge 上游配置并列出会导致实际请求失败的缺失项。
function readChatCompletionsPreflightConfig(env: RuntimeEnv): {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  missing: string[];
} {
  const apiKey = readChatCompletionsApiKey(env);
  const baseURL = readChatCompletionsBaseURL(env);
  const model = readChatCompletionsModel(env);
  const missing: string[] = [];

  if (apiKey === undefined || apiKey.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_API_KEY");
  }
  if (baseURL === undefined || baseURL.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_BASE_URL");
  }
  if (model === undefined || model.trim().length === 0) {
    missing.push("KODEKS_CHAT_COMPLETIONS_MODEL");
  }

  return { apiKey, baseURL, model, missing };
}

// Reads the bridge URL only for local HTTP endpoints that the web runtime can manage.
function readManagedBridgeBaseURL(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") {
    return null;
  }
  if (
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "localhost" &&
    url.hostname !== "::1"
  ) {
    return null;
  }
  return url;
}

// Checks whether a local bridge is already running before starting an embedded one.
async function isManagedBridgeHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(500),
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
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

// Loads env files from the monorepo workspace root once for nested Next.js apps.
function loadWorkspaceEnv(): void {
  if (workspaceEnvLoaded) {
    return;
  }

  if (process.env.NODE_ENV !== "test") {
    loadEnvConfig(
      resolveWorkspaceRoot(),
      process.env.NODE_ENV !== "production",
      undefined,
      true,
    );
  }
  workspaceEnvLoaded = true;
}

// Reads a normalized session id from loose HTTP request payloads.
function readSessionId(body: ChatStreamRequest): string | null {
  return typeof body.session_id === "string" && body.session_id.trim()
    ? body.session_id.trim()
    : null;
}

// Reads the optional provider/model ref selected by the UI, such as "qwen/qwen3.6".
function readRequestedModelRef(
  body: Pick<ChatStreamRequest, "model">,
): string | null {
  return typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : null;
}

// Reads the optional per-session model provider override from loose HTTP payloads.
function readProviderOverride(
  body: ChatStreamRequest,
): ModelProviderOverride | null {
  if (body.provider === "openai" || body.provider === "moonbridge") {
    return body.provider;
  }
  if (
    body.provider === "responses" ||
    body.provider === "bridge" ||
    body.provider === "deepseek" ||
    body.provider === "chat-completions"
  ) {
    throw new ModelConfigurationError(
      `Provider override "${body.provider}" has been removed. Use "openai" or "moonbridge".`,
    );
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
    join(resolveWorkspaceRoot(), ".kodeks", "kodeks.sqlite3");
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
  return join(/* turbopackIgnore: true */ process.cwd(), "../..");
}

// Converts product agent events into the existing frontend SSE wire format.
function toSseFrame(event: AgentEvent): string {
  const payload = toWirePayload(event);
  return `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// Converts camelCase runtime events into snake_case transport payloads.
function toWirePayload(event: AgentEvent): Record<string, unknown> {
  if (event.type === "session_created") {
    return { type: "session_created", session_id: event.sessionId };
  }
  if (event.type === "assistant_status") {
    return {
      type: "assistant_status",
      message: event.message,
      session_id: event.sessionId,
    };
  }
  if (event.type === "text_delta") {
    return {
      type: "text_delta",
      delta: event.text,
      session_id: event.sessionId,
    };
  }
  if (event.type === "tool_call") {
    return {
      type: "tool_call",
      tool_call_id: event.id,
      tool_name: event.name,
      tool_arguments: event.args,
      session_id: event.sessionId,
    };
  }
  if (event.type === "tool_result") {
    return {
      type: "tool_result",
      tool_call_id: event.id,
      tool_name: event.name,
      tool_output: event.output,
      tool_status: event.status,
      session_id: event.sessionId,
    };
  }
  if (event.type === "approval_required") {
    return {
      type: "approval_required",
      approval_id: event.approvalId,
      tool_call_id: event.toolCallId,
      message: event.reason,
      session_id: event.sessionId,
    };
  }
  if (event.type === "memory_recalled") {
    return {
      type: "memory_recalled",
      memory_ids: event.memoryIds,
      memory_layers: event.layers,
      session_id: event.sessionId,
    };
  }
  if (event.type === "plan_artifact") {
    return {
      type: "plan_artifact",
      action: event.action,
      plan: event.plan,
      session_id: event.sessionId,
    };
  }
  if (event.type === "subagent_started") {
    return {
      type: "subagent_started",
      run_id: event.runId,
      agent: event.agent,
      session_id: event.sessionId,
    };
  }
  if (event.type === "subagent_completed") {
    return {
      type: "subagent_completed",
      run_id: event.runId,
      summary: event.summary,
      session_id: event.sessionId,
    };
  }
  if (event.type === "response_completed") {
    return {
      type: "response_completed",
      response_id: event.responseId,
      session_id: event.sessionId,
    };
  }
  return {
    type: "error",
    message: event.message,
    code: event.code,
    session_id: event.sessionId,
  };
}
