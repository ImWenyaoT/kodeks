export type ChatMode = "act" | "plan";

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
      toolName?: string;
      toolArguments?: Record<string, unknown>;
      sessionId?: string;
    }
  | {
      type: "tool_result";
      toolName?: string;
      toolStatus?: string;
      toolOutput?: unknown;
      sessionId?: string;
    }
  | {
      type: "approval_required";
      approvalId: string;
      message: string;
      sessionId?: string;
    }
  | {
      type: "memory_recalled";
      memoryIds: string[];
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
  tool_name?: string;
  tool_arguments?: Record<string, unknown>;
  tool_status?: string;
  tool_output?: unknown;
  approval_id?: string;
  memory_ids?: string[];
  run_id?: string;
  agent?: string;
  summary?: string;
  message?: string;
};

type CollectChatStreamHandlers = {
  onDelta?: (delta: string) => void;
  onEvent?: (event: ChatStreamEvent) => void;
};

// Parses the FastAPI SSE wire format into UI-friendly event objects.
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
      toolName: rawEvent.tool_name,
      toolArguments: rawEvent.tool_arguments,
      sessionId: rawEvent.session_id
    };
  }

  if (rawEvent.type === "tool_result") {
    return {
      type: "tool_result",
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

// Dispatches parsed events to the text-delta and generic event callbacks.
function emitEvents(events: ChatStreamEvent[], handlers: CollectChatStreamHandlers): void {
  for (const event of events) {
    handlers.onEvent?.(event);

    if (event.type === "text_delta") {
      handlers.onDelta?.(event.delta);
    }
  }
}
