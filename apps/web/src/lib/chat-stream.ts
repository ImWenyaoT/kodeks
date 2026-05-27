export type ChatMode = "act" | "plan";

export type ChatPlanStep = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  details: string | null;
};

export type ChatPlanArtifact = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  steps: ChatPlanStep[];
  status: "active" | "archived";
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatStreamEvent =
  | {
      type: "session_created";
      sessionId: string;
    }
  | {
      type: "assistant_status";
      message: string;
      sessionId?: string;
    }
  | {
      type: "text_delta";
      delta: string;
      sessionId?: string;
    }
  | {
      type: "response_completed";
      responseId: string;
      sessionId?: string;
    }
  | {
      type: "tool_call";
      toolCallId?: string;
      toolName?: string;
      toolArguments?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: "tool_result";
      toolCallId?: string;
      toolName?: string;
      toolStatus?: string;
      toolOutput?: unknown;
      sessionId?: string;
    }
  | {
      type: "approval_required";
      approvalId: string;
      toolCallId?: string;
      message: string;
      sessionId?: string;
    }
  | {
      type: "memory_recalled";
      memoryIds: string[];
      sessionId?: string;
    }
  | {
      type: "plan_artifact";
      action: "created" | "recovered";
      plan: ChatPlanArtifact;
      sessionId?: string;
    }
  | {
      type: "subagent_started";
      runId: string;
      agent: string;
      sessionId?: string;
    }
  | {
      type: "subagent_completed";
      runId: string;
      summary: string;
      sessionId?: string;
    }
  | {
      type: "error";
      message: string;
      sessionId?: string;
    };

type RawChatStreamEvent = {
  type?: string;
  delta?: string;
  response_id?: string;
  session_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_arguments?: Record<string, unknown>;
  tool_status?: string;
  tool_output?: unknown;
  approval_id?: string;
  memory_ids?: string[];
  action?: string;
  plan?: unknown;
  run_id?: string;
  agent?: string;
  summary?: string;
  message?: string;
};

type CollectChatStreamHandlers = {
  onDelta?: (delta: string) => void;
  onEvent?: (event: ChatStreamEvent) => void;
};

// Parses the runtime SSE wire format into UI-friendly event objects.
export function parseSseFrames(text: string): ChatStreamEvent[] {
  return text
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .flatMap((frame) => {
      const dataLines = frame
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length));

      if (dataLines.length === 0) {
        return [];
      }

      try {
        const rawEvent = JSON.parse(dataLines.join("\n")) as RawChatStreamEvent;
        const event = normalizeRawEvent(rawEvent);
        return event === null ? [] : [event];
      } catch {
        return [
          {
            type: "error",
            message: "Received an invalid stream frame."
          } satisfies ChatStreamEvent
        ];
      }
    });
}

// Reads a browser ReadableStream and emits parsed chat events as chunks arrive.
export async function collectChatStream(
  stream: ReadableStream<Uint8Array>,
  handlers: CollectChatStreamHandlers
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        emitEvents(parseSseFrames(buffer), handlers);
      }
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");

    if (boundary === -1) {
      continue;
    }

    const completeFrames = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    emitEvents(parseSseFrames(completeFrames), handlers);
  }
}

// Converts backend snake_case event payloads into a compact frontend contract.
function normalizeRawEvent(rawEvent: RawChatStreamEvent): ChatStreamEvent | null {
  if (rawEvent.type === "session_created") {
    return {
      type: "session_created",
      sessionId: rawEvent.session_id ?? ""
    };
  }

  if (rawEvent.type === "assistant_status") {
    return {
      type: "assistant_status",
      message: rawEvent.message ?? "",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "text_delta") {
    return {
      type: "text_delta",
      delta: rawEvent.delta ?? "",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "response_completed") {
    return {
      type: "response_completed",
      responseId: rawEvent.response_id ?? "",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "tool_call") {
    return {
      type: "tool_call",
      ...(rawEvent.tool_call_id === undefined ? {} : { toolCallId: rawEvent.tool_call_id }),
      toolName: rawEvent.tool_name,
      toolArguments: rawEvent.tool_arguments,
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "tool_result") {
    return {
      type: "tool_result",
      ...(rawEvent.tool_call_id === undefined ? {} : { toolCallId: rawEvent.tool_call_id }),
      toolName: rawEvent.tool_name,
      toolStatus: rawEvent.tool_status,
      toolOutput: rawEvent.tool_output,
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "approval_required") {
    return {
      type: "approval_required",
      approvalId: rawEvent.approval_id ?? "",
      ...(rawEvent.tool_call_id === undefined ? {} : { toolCallId: rawEvent.tool_call_id }),
      message: rawEvent.message ?? "Approval required.",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "memory_recalled") {
    return {
      type: "memory_recalled",
      memoryIds: rawEvent.memory_ids ?? [],
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "plan_artifact") {
    return {
      type: "plan_artifact",
      action: rawEvent.action === "recovered" ? "recovered" : "created",
      plan: normalizePlanArtifact(rawEvent.plan),
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "subagent_started") {
    return {
      type: "subagent_started",
      runId: rawEvent.run_id ?? "",
      agent: rawEvent.agent ?? "explore",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "subagent_completed") {
    return {
      type: "subagent_completed",
      runId: rawEvent.run_id ?? "",
      summary: rawEvent.summary ?? "",
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "error") {
    return {
      type: "error",
      message: rawEvent.message ?? "The backend returned an error.",
      sessionId: rawEvent.session_id
    };
  }

  return null;
}

// Normalizes plan artifacts from the runtime into a safe frontend shape.
function normalizePlanArtifact(plan: unknown): ChatPlanArtifact {
  const record = plan !== null && typeof plan === "object" && !Array.isArray(plan)
    ? (plan as Record<string, unknown>)
    : {};
  return {
    id: typeof record.id === "string" ? record.id : "",
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    title: typeof record.title === "string" ? record.title : "Plan",
    summary: typeof record.summary === "string" ? record.summary : "",
    steps: normalizePlanSteps(record.steps),
    status: record.status === "archived" ? "archived" : "active",
    sourceMessageId: typeof record.sourceMessageId === "string" ? record.sourceMessageId : null,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
  };
}

// Normalizes persisted plan steps from loose JSON.
function normalizePlanSteps(steps: unknown): ChatPlanStep[] {
  if (!Array.isArray(steps)) {
    return [];
  }
  return steps.flatMap((step) => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      return [];
    }
    const record = step as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.title !== "string") {
      return [];
    }
    return [
      {
        id: record.id,
        title: record.title,
        status: readPlanStepStatus(record.status),
        details: typeof record.details === "string" ? record.details : null
      }
    ];
  });
}

// Maps unknown plan status input to the frontend status union.
function readPlanStepStatus(status: unknown): ChatPlanStep["status"] {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

// Dispatches parsed events to the text-delta and generic event callbacks.
function emitEvents(events: ChatStreamEvent[], handlers: CollectChatStreamHandlers): void {
  for (const event of events) {
    handlers.onEvent?.(event);

    if (event.type === "text_delta") {
      handlers.onDelta?.(event.delta);
    }
  }
}
