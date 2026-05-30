import { collectChatStream, type ChatStreamEvent } from "./chat-stream";
import type { ChatMode } from "./chat-stream";
import type { ModelProviderOverride } from "@kodeks/model";

export type MoonBridgePreflightStatus =
  | "checking"
  | "ready"
  | "unavailable"
  | "not_required";

export type MoonBridgePreflightResult = {
  status: Exclude<MoonBridgePreflightStatus, "checking">;
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

export type MoonBridgePreflightView =
  | MoonBridgePreflightResult
  | {
      status: "checking";
      provider: ModelProviderOverride | "auto";
    };

export type ConfiguredModelOption = {
  ref: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  api: "responses" | "chat-completions";
  requiresBridge: boolean;
  baseURL?: string;
  configured: boolean;
};

export type ConfiguredModelCatalog = {
  primary?: string;
  models: ConfiguredModelOption[];
};

export type SendChatMessageInput = {
  input: string;
  sessionId?: string;
  mode: ChatMode;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  selectedFiles?: string[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onEvent: (event: ChatStreamEvent) => void;
};

// Sends one chat turn through the Next.js proxy route and streams backend events.
export async function sendChatMessage({
  input,
  sessionId,
  mode,
  model,
  reasoningEffort,
  selectedFiles = [],
  signal,
  onDelta,
  onEvent,
}: SendChatMessageInput): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      mode,
      model,
      reasoning_effort: reasoningEffort,
      ...(selectedFiles.length === 0 ? {} : { selected_files: selectedFiles }),
    }),
    signal,
  });

  if (!response.ok || response.body === null) {
    throw new Error(`Chat request failed with HTTP ${response.status}.`);
  }

  await collectChatStream(response.body, {
    onDelta,
    onEvent,
  });
}

// 请求服务端预检当前 provider 的 MoonBridge 状态，避免前端凭配置猜测。
export async function fetchMoonBridgePreflight(
  model?: string,
  signal?: AbortSignal,
): Promise<MoonBridgePreflightResult> {
  const response = await fetch("/api/bridge/preflight", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(model === undefined || model === "" ? {} : { model }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `MoonBridge preflight failed with HTTP ${response.status}.`,
    );
  }

  return (await response.json()) as MoonBridgePreflightResult;
}

// 读取用户配置中的模型清单，用于前端 provider/model 选择器。
export async function fetchConfiguredModels(
  signal?: AbortSignal,
): Promise<ConfiguredModelCatalog> {
  const response = await fetch("/api/models", { signal });
  if (!response.ok) {
    throw new Error(
      `Model catalog request failed with HTTP ${response.status}.`,
    );
  }
  return (await response.json()) as ConfiguredModelCatalog;
}
