import { Agent, type FunctionTool, tool } from "@openai/agents";
import type { ModelClient, ModelTurnRequest, ModelTurnStreamEvent } from "@kodeks/model";
import type { KodeksDatabase, SessionMode, StoredMemory } from "@kodeks/storage";
import {
  ToolExecutionContext,
  buildDefaultToolRegistry,
  type ToolDefinition,
  type ToolRegistry
} from "@kodeks/tools";
import type { WorkspaceService } from "@kodeks/workspace";

export type AgentEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "text_delta"; text: string; sessionId: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; sessionId: string }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output: string;
      status: "ok" | "error" | "approval_required";
      sessionId: string;
    }
  | { type: "approval_required"; approvalId: string; toolCallId: string; reason: string; sessionId: string }
  | { type: "memory_recalled"; memoryIds: string[]; sessionId: string }
  | { type: "subagent_started"; runId: string; agent: "explore"; sessionId: string }
  | { type: "subagent_completed"; runId: string; summary: string; sessionId: string }
  | { type: "response_completed"; sessionId: string; responseId: string }
  | { type: "error"; message: string; code?: string; sessionId: string };

export type RunChatTurnInput = {
  input: string;
  sessionId?: string | null;
  mode: SessionMode;
  workspace: WorkspaceService;
  database: KodeksDatabase;
  model: ModelClient;
};

export type { ModelClient, ModelTurnRequest, ModelTurnStreamEvent };

export type BuildAgentsSdkBuildAgentInput = {
  workspace: WorkspaceService;
  database: KodeksDatabase;
  mode: SessionMode;
  model: string;
};

// Runs one product-level chat turn and yields stable internal agent events.
export async function* runChatTurn(input: RunChatTurnInput): AsyncIterable<AgentEvent> {
  const sessionId = input.sessionId?.trim() || `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  const existingSession = await input.database.sessions.getSession(sessionId);
  if (existingSession === null) {
    await input.database.sessions.createSession({
      id: sessionId,
      title: "Kodeks session",
      mode: input.mode,
      workspaceRoot: input.workspace.rootPath()
    });
    if (!input.sessionId) {
      yield { type: "session_created", sessionId };
    }
  } else if (existingSession.mode !== input.mode) {
    await input.database.sessions.updateMode(sessionId, input.mode);
  }

  await input.database.sessions.appendMessage({
    sessionId,
    role: "user",
    content: { text: input.input }
  });

  const recalledMemories = await input.database.memories.recall(input.input);
  if (recalledMemories.length > 0) {
    yield {
      type: "memory_recalled",
      memoryIds: recalledMemories.map((memory) => memory.id),
      sessionId
    };
  }

  const registry = buildDefaultToolRegistry({
    workspace: input.workspace,
    database: input.database
  });
  const request = await buildModelTurnRequest({
    input: input.input,
    mode: input.mode,
    database: input.database,
    sessionId,
    recalledMemories,
    registry
  });
  let assistantText = "";

  let pendingRequest: ModelTurnRequest | null = request;

  while (pendingRequest !== null) {
    const toolMessages: Array<{ toolCallId: string; name: string; output: string }> = [];
    let responseCompleted = false;

    for await (const modelEvent of input.model.streamTurn(pendingRequest)) {
    if (modelEvent.type === "text_delta") {
      assistantText += modelEvent.text;
      yield { type: "text_delta", text: modelEvent.text, sessionId };
      continue;
    }

      if (modelEvent.type === "tool_call") {
        yield {
          type: "tool_call",
          id: modelEvent.id,
          name: modelEvent.name,
          args: modelEvent.args,
          sessionId
        };
        const result = await registry.execute(
          modelEvent.name,
          modelEvent.args,
          new ToolExecutionContext(sessionId, modelEvent.id)
        );
        const mappedStatus = mapToolStatus(result.status);
        yield {
          type: "tool_result",
          id: modelEvent.id,
          name: modelEvent.name,
          output: result.output,
          status: mappedStatus,
          sessionId
        };
        toolMessages.push({ toolCallId: modelEvent.id, name: modelEvent.name, output: result.output });
        if (mappedStatus === "approval_required") {
          const parsedOutput = parseToolOutput(result.output);
          yield {
            type: "approval_required",
            approvalId: stringFromParsed(parsedOutput.approvalId),
            toolCallId: modelEvent.id,
            reason: stringFromParsed(parsedOutput.reason),
            sessionId
          };
        }
        continue;
      }

      if (modelEvent.type === "response_completed") {
        responseCompleted = true;
        if (assistantText.length > 0) {
          await input.database.sessions.appendMessage({
            sessionId,
            role: "assistant",
            content: { text: assistantText }
          });
        }
        yield {
          type: "response_completed",
          sessionId,
          responseId: modelEvent.responseId
        };
        continue;
      }

      yield {
        type: "error",
        message: modelEvent.message,
        sessionId
      };
    }

    if (responseCompleted || toolMessages.length === 0) {
      pendingRequest = null;
      continue;
    }

    pendingRequest = {
      ...pendingRequest,
      messages: [
        ...pendingRequest.messages,
        ...toolMessages.map((message) => ({
          role: "tool" as const,
          content: message.output,
          toolCallId: message.toolCallId,
          name: message.name
        }))
      ]
    };
  }
}

// Builds an OpenAI Agents SDK Agent with local function tool wrappers.
export function buildAgentsSdkBuildAgent(input: BuildAgentsSdkBuildAgentInput): Agent {
  const registry = buildDefaultToolRegistry({
    workspace: input.workspace,
    database: input.database
  });
  return new Agent({
    name: "Kodeks Build Agent",
    instructions: buildAgentInstructions(input.mode),
    model: input.model,
    tools: registry.definitions({ readOnlyOnly: input.mode === "plan" }).map((definition) =>
      toAgentsSdkTool(definition, registry)
    )
  });
}

// Builds the model request from transcript, recalled memory, mode, and tools.
async function buildModelTurnRequest(input: {
  input: string;
  mode: SessionMode;
  database: KodeksDatabase;
  sessionId: string;
  recalledMemories: StoredMemory[];
  registry: ToolRegistry;
}): Promise<ModelTurnRequest> {
  const transcript = await input.database.sessions.getTranscript(input.sessionId);
  return {
    messages: [
      {
        role: "system",
        content: buildSystemContext(input.mode, input.recalledMemories)
      },
      ...transcript.map((message) => ({
        role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
        content: stringifyMessageContent(message.content)
      }))
    ],
    tools: input.registry.definitions({ readOnlyOnly: input.mode === "plan" })
  };
}

// Converts one local registry definition into an OpenAI Agents SDK function tool.
function toAgentsSdkTool(definition: ToolDefinition, registry: ToolRegistry): FunctionTool {
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as never,
    strict: false,
    execute: async (rawInput, runContext, details) => {
      const args = typeof rawInput === "object" && rawInput !== null ? (rawInput as Record<string, unknown>) : {};
      const result = await registry.execute(
        definition.name,
        args,
        new ToolExecutionContext(null, details?.toolCall?.callId ?? null)
      );
      return result.output;
    }
  });
}

// Builds mode-specific system instructions for the Agents SDK agent.
function buildAgentInstructions(mode: SessionMode): string {
  if (mode === "plan") {
    return "You are Kodeks Plan Agent. Inspect the workspace and produce a plan. Do not mutate files or run shell commands.";
  }
  return "You are Kodeks Build Agent. Help with coding tasks using the provided workspace, memory, shell, and subagent tools.";
}

// Builds system context for the model client request.
function buildSystemContext(mode: SessionMode, recalledMemories: StoredMemory[]): string {
  const memoryBlock =
    recalledMemories.length === 0
      ? "No recalled memories."
      : recalledMemories.map((memory) => `- [${memory.scope}] ${memory.content}`).join("\n");
  return `${buildAgentInstructions(mode)}\n\nRecalled memory:\n${memoryBlock}`;
}

// Converts stored JSON message content into text for model input.
function stringifyMessageContent(content: unknown): string {
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

// Maps local tool statuses into the product event contract.
function mapToolStatus(status: string): "ok" | "error" | "approval_required" {
  if (status === "completed") {
    return "ok";
  }
  if (status === "approval_required") {
    return "approval_required";
  }
  return "error";
}

// Parses JSON tool output for approval metadata extraction.
function parseToolOutput(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// Reads one string value from parsed tool JSON.
function stringFromParsed(value: unknown): string {
  return typeof value === "string" ? value : "";
}
