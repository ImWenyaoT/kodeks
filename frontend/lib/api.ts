/**
 * 类型化的后端 API 客户端。
 * 全部使用相对 URL（`/api/...`），使得开发期代理与生产期静态导出都能工作。
 * 后端返回的字段保持 camelCase，与此处类型一一对应。
 */

/**
 * 发起一次 fetch 请求并解析 JSON。
 * 非 2xx 响应会抛出错误（携带路径与 HTTP 状态码），调用方需自行处理。
 */
export async function requestJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} failed with HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// ---- Models (§5.1/§5.2) ----

export type ModelOption = {
  ref: string;
  providerId: string;
  providerName?: string;
  modelId?: string;
  modelName: string;
  requiresBridge?: boolean;
  baseURL?: string | null;
  configured: boolean;
};
export type ModelCatalog = { models: ModelOption[]; primary: string | null };

/**
 * 拉取模型目录，仅保留 `configured` 为真的模型。
 * 缺省字段做空值兜底：models 缺省为空数组，primary 缺省为 null。
 */
export async function getModels(): Promise<ModelCatalog> {
  const cat = await requestJson<ModelCatalog>("/api/models");
  return {
    models: (cat.models ?? []).filter((m) => m && m.configured),
    primary: cat.primary ?? null,
  };
}

// ---- Sessions ----

export type SessionSummary = {
  id: string;
  title?: string;
  mode?: string;
  updatedAt?: string;
  createdAt?: string;
};

/**
 * 获取会话列表。GET /api/sessions -> { sessions: SessionSummary[] }。
 * sessions 缺省时返回空数组。
 */
export async function getSessions(): Promise<SessionSummary[]> {
  const b = await requestJson<{ sessions?: SessionSummary[] }>("/api/sessions");
  return b.sessions ?? [];
}

export type StoredMessage = {
  id: string;
  sessionId: string;
  role: string;
  content?: unknown;
  agentEvent?: unknown;
  createdAt?: string;
};

/**
 * 获取单个会话详情。GET /api/sessions/{id} -> { session, messages, plan? }。
 * messages 缺省时返回空数组；session 与 plan 原样透传。
 */
export async function getSession(
  id: string,
): Promise<{ session?: unknown; messages: StoredMessage[]; plan?: unknown }> {
  const b = await requestJson<{
    session?: unknown;
    messages?: StoredMessage[];
    plan?: unknown;
  }>(`/api/sessions/${id}`);
  return { session: b.session, messages: b.messages ?? [], plan: b.plan };
}

// ---- Workspace ----

/**
 * 列出工作区文件。GET /api/workspace/files -> { files: string[] }。
 * files 缺省时返回空数组。
 */
export async function getWorkspaceFiles(): Promise<string[]> {
  const b = await requestJson<{ files?: string[] }>("/api/workspace/files");
  return b.files ?? [];
}

// ---- Bridge ----

export type BridgePreflight = {
  status: string;
  provider?: string;
  resolvedProvider?: string;
  reason?: string;
  bridgeBaseURL?: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
  bridgeModel?: string;
};

/**
 * 对指定模型做 bridge 预检。POST /api/bridge/preflight {model} -> 状态对象。
 */
export async function bridgePreflight(model: string): Promise<BridgePreflight> {
  return requestJson<BridgePreflight>("/api/bridge/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

// ---- Approvals ----

/**
 * 对一条审批做出决策。POST /api/approvals/{id} {decision} -> { approval, result? }。
 */
export async function decideApproval(
  id: string,
  decision: "approve" | "reject",
): Promise<{
  approval?: unknown;
  result?: { exitCode?: number; stdout?: string; stderr?: string };
}> {
  return requestJson(`/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
}

// ---- Chat stream ----

export type ChatStreamBody = {
  input: string;
  session_id?: string;
  mode: "act" | "plan";
  model: string;
  reasoning_effort: "low" | "medium" | "high" | "xhigh";
  selected_files: string[];
};

/**
 * 打开聊天流式响应。POST /api/chat/stream。
 * 返回原始的流式 `Response`，供 `readSse` 逐帧消费；通过 `signal` 支持中断。
 */
export function openChatStream(
  body: ChatStreamBody,
  signal: AbortSignal,
): Promise<Response> {
  return fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
