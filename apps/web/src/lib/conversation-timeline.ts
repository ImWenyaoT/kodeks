import type { ChatStreamEvent } from "./chat-stream";

export type TimelineMessageItem = {
  type: "message";
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

export type TimelineToolItem = {
  type: "tool";
  id: string;
  toolCallId?: string;
  name: string;
  status: "in_progress" | "completed" | "failed" | "approval_required";
  input?: unknown;
  output?: unknown;
};

export type TimelineApprovalItem = {
  type: "approval";
  id: string;
  approvalId: string;
  toolCallId?: string;
  reason: string;
  state: "waiting" | "approved" | "rejected" | "failed";
};

export type TimelineMemoryItem = {
  type: "memory";
  id: string;
  memoryIds: string[];
  layers?: Record<string, number>;
};

export type TimelinePlanItem = {
  type: "plan";
  id: string;
  action: "created" | "recovered";
  title: string;
  summary: string;
  stepCount: number;
};

export type TimelineStatusItem = {
  type: "status";
  id: string;
  message: string;
};

export type TimelineSubagentItem = {
  type: "subagent";
  id: string;
  runId: string;
  agent: string;
  summary?: string;
  status: "running" | "completed";
};

export type TimelineCompletionItem = {
  type: "completed";
  id: string;
  responseId: string;
};

export type TimelineErrorItem = {
  type: "error";
  id: string;
  message: string;
};

export type TimelineItem =
  | TimelineMessageItem
  | TimelineToolItem
  | TimelineApprovalItem
  | TimelineMemoryItem
  | TimelinePlanItem
  | TimelineStatusItem
  | TimelineSubagentItem
  | TimelineCompletionItem
  | TimelineErrorItem;

type MakeId = () => string;

const defaultMakeId: MakeId = () => crypto.randomUUID();

// Appends streamed assistant text to the active assistant timeline message.
export function appendAssistantDelta(
  items: TimelineItem[],
  assistantMessageId: string,
  delta: string,
): TimelineItem[] {
  return items.map((item) =>
    item.type === "message" && item.id === assistantMessageId
      ? { ...item, content: `${item.content}${delta}` }
      : item,
  );
}

// 去掉 stream 重放或热更新残留造成的重复时间线项，避免 React 渲染时出现重复 key。
export function dedupeTimelineItems(items: TimelineItem[]): TimelineItem[] {
  const seenIds = new Set<string>();
  const seenApprovalIds = new Set<string>();

  return items.filter((item) => {
    if (seenIds.has(item.id)) {
      return false;
    }
    seenIds.add(item.id);

    if (item.type !== "approval" || item.approvalId.length === 0) {
      return true;
    }
    if (seenApprovalIds.has(item.approvalId)) {
      return false;
    }
    seenApprovalIds.add(item.approvalId);
    return true;
  });
}

// Writes one runtime event into the conversation timeline used by the starter-style chat UI.
export function upsertRuntimeTimelineItem(
  items: TimelineItem[],
  event: ChatStreamEvent,
  makeId: MakeId = defaultMakeId,
): TimelineItem[] {
  if (event.type === "tool_call") {
    return [
      ...items,
      {
        type: "tool",
        id: `tool-${event.toolCallId ?? makeId()}`,
        toolCallId: event.toolCallId,
        name: event.toolName ?? "tool",
        status: "in_progress",
        input: event.toolArguments,
      },
    ];
  }

  if (event.type === "tool_result") {
    return updateToolResult(items, event, makeId);
  }

  if (event.type === "approval_required") {
    const existingApproval = items.find(
      (item) =>
        item.type === "approval" &&
        item.approvalId.length > 0 &&
        item.approvalId === event.approvalId,
    );
    if (existingApproval !== undefined) {
      return items.map((item) =>
        item.type === "approval" && item.approvalId === event.approvalId
          ? {
              ...item,
              toolCallId: item.toolCallId ?? event.toolCallId,
              reason: item.reason || event.message,
            }
          : item,
      );
    }

    return [
      ...items,
      {
        type: "approval",
        id: `approval-${event.approvalId || makeId()}`,
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        reason: event.message,
        state: "waiting",
      },
    ];
  }

  if (event.type === "memory_recalled") {
    return [
      ...items,
      {
        type: "memory",
        id: `memory-${makeId()}`,
        memoryIds: event.memoryIds,
        layers: event.layers,
      },
    ];
  }

  if (event.type === "plan_artifact") {
    return [
      ...items,
      {
        type: "plan",
        id: `plan-${event.plan.id || makeId()}`,
        action: event.action,
        title: event.plan.title,
        summary: event.plan.summary,
        stepCount: event.plan.steps.length,
      },
    ];
  }

  if (event.type === "assistant_status") {
    return [
      ...items,
      { type: "status", id: `status-${makeId()}`, message: event.message },
    ];
  }

  if (event.type === "subagent_started") {
    return [
      ...items,
      {
        type: "subagent",
        id: `subagent-${event.runId || makeId()}`,
        runId: event.runId,
        agent: event.agent,
        status: "running",
      },
    ];
  }

  if (event.type === "subagent_completed") {
    return upsertSubagentCompletion(items, event, makeId);
  }

  if (event.type === "response_completed") {
    return [
      ...items,
      {
        type: "completed",
        id: `completed-${event.responseId || makeId()}`,
        responseId: event.responseId,
      },
    ];
  }

  if (event.type === "error") {
    return [
      ...items,
      {
        type: "error",
        id: `error-${makeId()}`,
        message: event.message,
      },
    ];
  }

  return items;
}

// Updates an existing approval card after the user responds to the backend approval route.
export function updateApprovalState(
  items: TimelineItem[],
  approvalId: string,
  state: TimelineApprovalItem["state"],
): TimelineItem[] {
  return items.map((item) =>
    item.type === "approval" && item.approvalId === approvalId
      ? { ...item, state }
      : item,
  );
}

// Converts unknown tool inputs and outputs into compact readable JSON snippets.
export function formatTimelinePayload(payload: unknown): string {
  if (payload === null || payload === undefined || payload === "") {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

// Merges a tool result into the matching tool-call row, falling back to a standalone row.
function updateToolResult(
  items: TimelineItem[],
  event: Extract<ChatStreamEvent, { type: "tool_result" }>,
  makeId: MakeId,
): TimelineItem[] {
  const toolIndex = findLastIndex(items, (item) => {
    if (item.type !== "tool") {
      return false;
    }
    if (
      event.toolCallId !== undefined &&
      item.toolCallId === event.toolCallId
    ) {
      return true;
    }
    return event.toolCallId === undefined && item.name === event.toolName;
  });
  const status = mapToolStatus(event.toolStatus);

  if (toolIndex === -1) {
    return [
      ...items,
      {
        type: "tool",
        id: `tool-${event.toolCallId ?? makeId()}`,
        toolCallId: event.toolCallId,
        name: event.toolName ?? "tool",
        status,
        output: event.toolOutput,
      },
    ];
  }

  return items.map((item, index) =>
    index === toolIndex && item.type === "tool"
      ? { ...item, status, output: event.toolOutput }
      : item,
  );
}

// Merges a subagent completion into its running row when possible.
function upsertSubagentCompletion(
  items: TimelineItem[],
  event: Extract<ChatStreamEvent, { type: "subagent_completed" }>,
  makeId: MakeId,
): TimelineItem[] {
  const subagentIndex = findLastIndex(
    items,
    (item) => item.type === "subagent" && item.runId === event.runId,
  );

  if (subagentIndex === -1) {
    return [
      ...items,
      {
        type: "subagent",
        id: `subagent-${event.runId || makeId()}`,
        runId: event.runId,
        agent: "explore",
        summary: event.summary,
        status: "completed",
      },
    ];
  }

  return items.map((item, index) =>
    index === subagentIndex && item.type === "subagent"
      ? { ...item, summary: event.summary, status: "completed" }
      : item,
  );
}

// Maps backend tool statuses into the UI states shown in the conversation.
function mapToolStatus(status: string | undefined): TimelineToolItem["status"] {
  if (status === "ok") {
    return "completed";
  }
  if (status === "approval_required") {
    return "approval_required";
  }
  if (status === "error") {
    return "failed";
  }
  return "completed";
}

// Finds the last matching item without relying on newer Array.prototype helpers in tests.
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) {
      return index;
    }
  }
  return -1;
}
