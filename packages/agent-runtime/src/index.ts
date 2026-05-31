import {
  Agent,
  OpenAIProvider,
  Runner,
  assistant,
  type AgentInputItem,
  type FunctionTool,
  type ModelSettings,
  type RunStreamEvent,
  setTracingDisabled,
  tool,
  user,
} from "@openai/agents";
import type {
  ChatMessage,
  ModelClient,
  ModelTurnRequest,
  ModelTurnStreamEvent,
  ReasoningEffort,
} from "@kodeks/model";
import { loadModelRuntimeEnv } from "@kodeks/model";
import type {
  KodeksDatabase,
  MemoryContext,
  MemoryService,
  SessionMode,
  StoredMessage,
  StoredPlanArtifact,
} from "@kodeks/storage";
import { MemoryService as KodeksMemoryService } from "@kodeks/storage";
import {
  ToolExecutionContext,
  buildDefaultToolRegistry,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRegistry,
} from "@kodeks/tools";
import { isDangerousCommand, type WorkspaceService } from "@kodeks/workspace";

import { buildPlanArtifactContent } from "./plan-artifacts";

export type AgentEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "assistant_status"; message: string; sessionId: string }
  | { type: "text_delta"; text: string; sessionId: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: unknown;
      sessionId: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      output: string;
      status: "ok" | "error" | "approval_required";
      sessionId: string;
    }
  | {
      type: "approval_required";
      approvalId: string;
      toolCallId: string;
      reason: string;
      sessionId: string;
    }
  | {
      type: "memory_recalled";
      memoryIds: string[];
      sessionId: string;
      layers?: Record<string, number>;
    }
  | {
      type: "plan_artifact";
      action: "created" | "recovered";
      plan: StoredPlanArtifact;
      sessionId: string;
    }
  | {
      type: "subagent_started";
      runId: string;
      agent: "explore";
      sessionId: string;
    }
  | {
      type: "subagent_completed";
      runId: string;
      summary: string;
      sessionId: string;
    }
  | { type: "response_completed"; sessionId: string; responseId: string }
  | { type: "error"; message: string; code?: string; sessionId: string };

export type RunChatTurnInput = {
  input: string;
  sessionId?: string | null;
  mode: SessionMode;
  workspace: WorkspaceService;
  database: KodeksDatabase;
  selectedFiles?: SelectedWorkspaceFileContext[];
  environment?: Record<string, string | undefined>;
  model?: ModelClient;
  agents?: AgentsSdkRuntimeConfig;
};

export type { ModelClient, ModelTurnRequest, ModelTurnStreamEvent };

export type BuildAgentsSdkBuildAgentInput = {
  workspace: WorkspaceService;
  database: KodeksDatabase;
  mode: SessionMode;
  model: string;
  sessionId?: string | null;
  registry?: ToolRegistry;
  memoryContext?: MemoryContext;
  activePlan?: StoredPlanArtifact | null;
  selectedFiles?: SelectedWorkspaceFileContext[];
  environment?: Record<string, string | undefined>;
  approvalState?: Map<string, AgentsSdkApprovalMetadata>;
};

export type AgentsSdkRuntimeConfig = {
  provider: "openai" | "moonbridge";
  apiKey: string;
  baseURL?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  statefulResponses?: boolean;
  strictTools?: boolean;
  runner?: AgentsSdkRunner;
  signal?: AbortSignal;
};

export type AgentsSdkRunner = {
  run(
    agent: Agent,
    input: string | AgentInputItem[],
    options: { stream: true; signal?: AbortSignal; maxTurns?: number },
  ): Promise<AgentsSdkStreamResult>;
};

export type AgentsSdkStreamResult = AsyncIterable<RunStreamEvent> & {
  completed: Promise<void>;
  finalOutput?: unknown;
  interruptions?: unknown[];
  lastResponseId?: string;
};

type PreparedTurnState = {
  sessionId: string;
  activePlan: StoredPlanArtifact | null;
  memoryContext: MemoryContext;
  memoryService: MemoryService;
  registry: ToolRegistry;
};

type AgentsSdkApprovalMetadata = {
  approvalId: string;
  toolCallId: string;
  reason: string;
};

export type SelectedWorkspaceFileContext = {
  path: string;
  content?: string;
  truncated?: boolean;
  error?: string;
};

// Dispatches one product-level chat turn to the primary SDK runtime or the fallback model loop.
export async function* runChatTurn(
  input: RunChatTurnInput,
): AsyncIterable<AgentEvent> {
  const agents = input.agents;
  if (agents !== undefined) {
    yield* runAgentsSdkChatTurn({ ...input, agents });
    return;
  }

  if (input.model === undefined) {
    yield {
      type: "error",
      message: "No model runtime was configured.",
      sessionId: input.sessionId ?? "",
    };
    return;
  }

  yield* runModelClientChatTurn(
    input as RunChatTurnInput & { model: ModelClient },
  );
}

// Runs one fallback ModelClient turn for non-Responses providers and deterministic tests.
async function* runModelClientChatTurn(
  input: RunChatTurnInput & { model: ModelClient },
): AsyncIterable<AgentEvent> {
  const { sessionId, activePlan, memoryContext, memoryService, registry } =
    yield* prepareTurnState(input);
  const request = await buildModelTurnRequest({
    input: input.input,
    mode: input.mode,
    database: input.database,
    sessionId,
    memoryContext,
    activePlan,
    selectedFiles: input.selectedFiles,
    registry,
    environment: input.environment,
  });

  let pendingRequest: ModelTurnRequest | null = request;

  while (pendingRequest !== null) {
    const toolMessages: Array<{
      toolCallId: string;
      name: string;
      output: string;
    }> = [];
    const toolCalls: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
    }> = [];
    let assistantReasoningContent: string | undefined;
    let roundAssistantText = "";
    let responseCompleted = false;
    let waitingForApproval = false;
    let haltToolLoop = false;

    for await (const modelEvent of input.model.streamTurn(pendingRequest)) {
      if (modelEvent.type === "text_delta") {
        roundAssistantText += modelEvent.text;
        yield { type: "text_delta", text: modelEvent.text, sessionId };
        continue;
      }

      if (modelEvent.type === "tool_call") {
        assistantReasoningContent =
          modelEvent.reasoningContent ?? assistantReasoningContent;
        toolCalls.push({
          id: modelEvent.id,
          name: modelEvent.name,
          args: modelEvent.args,
        });
        yield {
          type: "assistant_status",
          message: `Using ${modelEvent.name}`,
          sessionId,
        };
        yield {
          type: "tool_call",
          id: modelEvent.id,
          name: modelEvent.name,
          args: modelEvent.args,
          sessionId,
        };
        if (!registry.has(modelEvent.name)) {
          const output = `Unknown tool requested by model: ${modelEvent.name}`;
          yield {
            type: "tool_result",
            id: modelEvent.id,
            name: modelEvent.name,
            output,
            status: "error",
            sessionId,
          };
          yield {
            type: "error",
            message: output,
            code: "model_requested_unknown_tool",
            sessionId,
          };
          haltToolLoop = true;
          continue;
        }
        const rawResult = await registry.execute(
          modelEvent.name,
          modelEvent.args,
          new ToolExecutionContext(sessionId, modelEvent.id),
        );
        const result = await compactToolExecutionResult({
          result: rawResult,
          memoryService,
          sessionId,
          toolCallId: modelEvent.id,
          toolName: modelEvent.name,
        });
        const mappedStatus = mapToolStatus(result.status);
        yield {
          type: "tool_result",
          id: modelEvent.id,
          name: modelEvent.name,
          output: result.output,
          status: mappedStatus,
          sessionId,
        };
        toolMessages.push({
          toolCallId: modelEvent.id,
          name: modelEvent.name,
          output: result.output,
        });
        if (mappedStatus === "approval_required") {
          const parsedOutput = parseToolOutput(result.output);
          yield {
            type: "approval_required",
            approvalId: stringFromParsed(parsedOutput.approvalId),
            toolCallId: modelEvent.id,
            reason: stringFromParsed(parsedOutput.reason),
            sessionId,
          };
          waitingForApproval = true;
        }
        continue;
      }

      if (modelEvent.type === "response_completed") {
        responseCompleted = true;
        yield* persistCompletedAssistantTurn({
          database: input.database,
          sessionId,
          mode: input.mode,
          userInput: input.input,
          assistantText: roundAssistantText,
          responseId: modelEvent.responseId,
        });
        continue;
      }

      yield {
        type: "error",
        message: modelEvent.message,
        sessionId,
      };
    }

    if (
      responseCompleted ||
      toolMessages.length === 0 ||
      waitingForApproval ||
      haltToolLoop
    ) {
      pendingRequest = null;
      continue;
    }

    await appendToolContinuationMessages({
      database: input.database,
      sessionId,
      assistantContent: roundAssistantText,
      reasoningContent: assistantReasoningContent,
      toolCalls,
      toolMessages,
    });

    pendingRequest = {
      ...pendingRequest,
      messages: [
        ...pendingRequest.messages,
        {
          role: "assistant" as const,
          content: roundAssistantText,
          reasoningContent: assistantReasoningContent,
          toolCalls,
        },
        ...toolMessages.map((message) => ({
          role: "tool" as const,
          content: message.output,
          toolCallId: message.toolCallId,
          name: message.name,
        })),
      ],
    };
  }
}

// Runs the primary OpenAI Agents SDK + Responses API turn and maps SDK events to Kodeks events.
async function* runAgentsSdkChatTurn(
  input: RunChatTurnInput & { agents: AgentsSdkRuntimeConfig },
): AsyncIterable<AgentEvent> {
  const { sessionId, activePlan, memoryContext, registry } =
    yield* prepareTurnState(input);
  const approvalState = new Map<string, AgentsSdkApprovalMetadata>();
  const agent = buildAgentsSdkBuildAgent({
    workspace: input.workspace,
    database: input.database,
    mode: input.mode,
    model: input.agents.model,
    sessionId,
    registry,
    memoryContext,
    activePlan,
    selectedFiles: input.selectedFiles,
    approvalState,
  });
  const runner = input.agents.runner ?? createAgentsSdkRunner(input.agents);
  const transcript = await input.database.sessions.getTranscript(sessionId);
  const result = await runner.run(agent, toAgentsSdkInputItems(transcript), {
    stream: true,
    signal: input.agents.signal,
    maxTurns: 12,
  });
  let assistantText = "";
  let waitingForApproval = false;

  for await (const event of result) {
    const textDelta = readAgentsSdkTextDelta(event);
    if (textDelta !== null) {
      assistantText += textDelta;
      yield { type: "text_delta", text: textDelta, sessionId };
      continue;
    }

    const toolCall = readAgentsSdkToolCall(event);
    if (toolCall !== null) {
      yield {
        type: "assistant_status",
        message: `Using ${toolCall.name}`,
        sessionId,
      };
      yield {
        type: "tool_call",
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        sessionId,
      };
      continue;
    }

    const toolResult = readAgentsSdkToolResult(event);
    if (toolResult !== null) {
      yield {
        type: "tool_result",
        id: toolResult.id,
        name: toolResult.name,
        output: toolResult.output,
        status: toolResult.status,
        sessionId,
      };
      if (toolResult.status === "approval_required") {
        const parsedOutput = parseToolOutput(toolResult.output);
        waitingForApproval = true;
        yield {
          type: "approval_required",
          approvalId: stringFromParsed(parsedOutput.approvalId),
          toolCallId: toolResult.id,
          reason: stringFromParsed(parsedOutput.reason),
          sessionId,
        };
      }
      continue;
    }

    const approval = readAgentsSdkApproval(event, approvalState);
    if (approval !== null) {
      waitingForApproval = true;
      yield {
        type: "approval_required",
        approvalId: approval.approvalId,
        toolCallId: approval.toolCallId,
        reason: approval.reason,
        sessionId,
      };
    }
  }

  await result.completed;
  const interruptions = result.interruptions ?? [];
  for (const interruption of interruptions) {
    const approval = approvalFromSdkItem(interruption, approvalState);
    if (approval !== null) {
      waitingForApproval = true;
      yield {
        type: "approval_required",
        approvalId: approval.approvalId,
        toolCallId: approval.toolCallId,
        reason: approval.reason,
        sessionId,
      };
    }
  }

  if (waitingForApproval) {
    return;
  }

  const finalText =
    assistantText.length > 0
      ? assistantText
      : stringifyFinalOutput(result.finalOutput);
  yield* persistCompletedAssistantTurn({
    database: input.database,
    sessionId,
    mode: input.mode,
    userInput: input.input,
    assistantText: finalText,
    responseId:
      result.lastResponseId ??
      `agents_${crypto.randomUUID().replaceAll("-", "")}`,
  });
}

// Creates or resumes session state, recalls memory, and constructs the local tool registry.
async function* prepareTurnState(
  input: RunChatTurnInput,
): AsyncGenerator<AgentEvent, PreparedTurnState> {
  const sessionId =
    input.sessionId?.trim() ||
    `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  const existingSession = await input.database.sessions.getSession(sessionId);
  if (existingSession === null) {
    await input.database.sessions.createSession({
      id: sessionId,
      title: "Kodeks session",
      mode: input.mode,
      workspaceRoot: input.workspace.rootPath(),
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
    content: { text: input.input },
  });

  const activePlan = await input.database.plans.getActiveBySession(sessionId);
  if (activePlan !== null) {
    yield {
      type: "plan_artifact",
      action: "recovered",
      plan: activePlan,
      sessionId,
    };
  }

  const memoryService = new KodeksMemoryService({
    database: input.database,
    workspaceRoot: input.workspace.rootPath(),
    environment: resolveRuntimeEnvironment(input.environment),
  });
  await memoryService.recordUserInput({ sessionId, content: input.input });
  const memoryContext = await memoryService.buildContext({
    sessionId,
    query: input.input,
  });
  const memoryIds = [
    ...memoryContext.profiles.map((memory) => memory.id),
    ...memoryContext.recalledItems.map((memory) => memory.id),
  ];
  if (memoryIds.length > 0) {
    yield {
      type: "memory_recalled",
      memoryIds,
      sessionId,
      layers: countMemoryLayers(memoryContext),
    };
  }

  const registry = buildDefaultToolRegistry({
    workspace: input.workspace,
    database: input.database,
  });
  return { sessionId, activePlan, memoryContext, memoryService, registry };
}

// Builds an OpenAI Agents SDK Agent with local function tool wrappers.
export function buildAgentsSdkBuildAgent(
  input: BuildAgentsSdkBuildAgentInput,
): Agent {
  const registry =
    input.registry ??
    buildDefaultToolRegistry({
      workspace: input.workspace,
      database: input.database,
    });
  return new Agent({
    name: "Kodeks Build Agent",
    instructions: buildSystemContext(
      input.mode,
      input.memoryContext ?? emptyMemoryContext(),
      input.activePlan ?? null,
      input.selectedFiles ?? [],
    ),
    model: input.model,
    tools: registry
      .definitions({ readOnlyOnly: input.mode === "plan" })
      .map((definition) =>
        toAgentsSdkTool(definition, registry, {
          database: input.database,
          sessionId: input.sessionId ?? null,
          workspaceRoot: input.workspace.rootPath(),
          environment: input.environment,
          approvalState: input.approvalState ?? new Map(),
          strict: input.environment?.KODEKS_STRICT_TOOL_SCHEMAS === "true",
        }),
      ),
  });
}

// Builds the model request from transcript, recalled memory, mode, and tools.
async function buildModelTurnRequest(input: {
  input: string;
  mode: SessionMode;
  database: KodeksDatabase;
  sessionId: string;
  memoryContext: MemoryContext;
  activePlan: StoredPlanArtifact | null;
  selectedFiles?: SelectedWorkspaceFileContext[];
  registry: ToolRegistry;
  environment?: Record<string, string | undefined>;
}): Promise<ModelTurnRequest> {
  const transcript = await input.database.sessions.getTranscript(
    input.sessionId,
  );
  return {
    ...(input.environment?.KODEKS_RESPONSES_STATEFUL === "true"
      ? {
          previousResponseId:
            await input.database.sessions.getLatestAssistantResponseId(
              input.sessionId,
            ),
        }
      : {}),
    messages: [
      {
        role: "system",
        content: buildSystemContext(
          input.mode,
          input.memoryContext,
          input.activePlan,
          input.selectedFiles ?? [],
        ),
      },
      ...transcript.flatMap(toModelTranscriptMessage),
    ],
    tools: input.registry.definitions({ readOnlyOnly: input.mode === "plan" }),
  };
}

// Persists model tool-call continuation data so DeepSeek thinking mode can resume later turns.
async function appendToolContinuationMessages(input: {
  database: KodeksDatabase;
  sessionId: string;
  assistantContent: string;
  reasoningContent?: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolMessages: Array<{ toolCallId: string; name: string; output: string }>;
}): Promise<void> {
  await input.database.sessions.appendMessage({
    sessionId: input.sessionId,
    role: "assistant",
    content: {
      text: input.assistantContent,
      reasoningContent: input.reasoningContent,
      toolCalls: input.toolCalls,
    },
  });

  for (const message of input.toolMessages) {
    await input.database.sessions.appendMessage({
      sessionId: input.sessionId,
      role: "tool",
      content: {
        text: message.output,
        toolCallId: message.toolCallId,
        name: message.name,
      },
    });
  }
}

// Converts stored transcript rows back into the model client's structured message contract.
function toModelTranscriptMessage(message: StoredMessage): ChatMessage[] {
  if (message.role === "tool") {
    const content = readObjectContent(message.content);
    return [
      {
        role: "tool",
        content: stringifyMessageContent(message.content),
        toolCallId: stringField(content, "toolCallId"),
        name: stringField(content, "name"),
      },
    ];
  }

  if (message.role === "assistant") {
    const content = readObjectContent(message.content);
    return [
      {
        role: "assistant",
        content: stringifyMessageContent(message.content),
        reasoningContent: stringField(content, "reasoningContent"),
        toolCalls: readToolCalls(content.toolCalls),
      },
    ];
  }

  return [
    {
      role: "user",
      content: stringifyMessageContent(message.content),
    },
  ];
}

// Creates an OpenAI-compatible Agents SDK runner pinned to the Responses API.
function createAgentsSdkRunner(
  config: AgentsSdkRuntimeConfig,
): AgentsSdkRunner {
  process.env.OPENAI_AGENTS_DISABLE_TRACING ??= "1";
  setTracingDisabled(process.env.OPENAI_AGENTS_TRACING_DISABLED !== "false");
  const provider = new OpenAIProvider({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    useResponses: true,
  });
  const modelSettings: ModelSettings = {
    reasoning: {
      effort: config.reasoningEffort,
    },
  };
  return new Runner({
    modelProvider: provider,
    modelSettings,
    tracingDisabled: process.env.OPENAI_AGENTS_TRACING_DISABLED !== "false",
    traceIncludeSensitiveData: false,
    workflowName: "Kodeks chat turn",
  });
}

// Converts durable chat history into Agents SDK input items while letting tools be re-run only inside a fresh turn.
function toAgentsSdkInputItems(transcript: StoredMessage[]): AgentInputItem[] {
  return transcript.flatMap((message) => {
    const text = stringifyMessageContent(message.content);
    if (text.trim().length === 0 || message.role === "tool") {
      return [];
    }
    if (message.role === "assistant") {
      return [assistant(text) as AgentInputItem];
    }
    return [user(text) as AgentInputItem];
  });
}

// Persists a completed assistant response and emits plan/completion events.
async function* persistCompletedAssistantTurn(input: {
  database: KodeksDatabase;
  sessionId: string;
  mode: SessionMode;
  userInput: string;
  assistantText: string;
  responseId: string;
}): AsyncGenerator<AgentEvent> {
  if (input.assistantText.length > 0) {
    const assistantMessage = await input.database.sessions.appendMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: { text: input.assistantText, responseId: input.responseId },
    });
    if (input.mode === "plan") {
      const plan = await input.database.plans.upsertActive({
        ...buildPlanArtifactContent(input.userInput, input.assistantText),
        sessionId: input.sessionId,
        sourceMessageId: assistantMessage.id,
      });
      yield {
        type: "plan_artifact",
        action: "created",
        plan,
        sessionId: input.sessionId,
      };
    }
  }
  yield {
    type: "response_completed",
    sessionId: input.sessionId,
    responseId: input.responseId,
  };
}

// Reads streaming text deltas from OpenAI Agents SDK raw model events.
function readAgentsSdkTextDelta(event: RunStreamEvent): string | null {
  const data = readObjectContent(readObjectContent(event).data);
  if (
    data.type === "output_text_delta" ||
    data.type === "response.output_text.delta"
  ) {
    return typeof data.delta === "string" ? data.delta : null;
  }
  return null;
}

// Reads function call starts from OpenAI Agents SDK run-item events.
function readAgentsSdkToolCall(
  event: RunStreamEvent,
): { id: string; name: string; args: Record<string, unknown> } | null {
  const record = readObjectContent(event);
  if (
    record.type !== "run_item_stream_event" ||
    record.name !== "tool_called"
  ) {
    return null;
  }
  const item = readObjectContent(record.item);
  const rawItem = readObjectContent(item.rawItem);
  const id =
    readToolCallId(rawItem) ??
    readToolCallId(item) ??
    `tool_${crypto.randomUUID().replaceAll("-", "")}`;
  const name =
    stringField(rawItem, "name") ?? stringField(item, "name") ?? "tool";
  return {
    id,
    name,
    args: readToolArguments(rawItem.arguments),
  };
}

// Reads function call outputs from OpenAI Agents SDK run-item events.
function readAgentsSdkToolResult(event: RunStreamEvent): {
  id: string;
  name: string;
  output: string;
  status: "ok" | "error" | "approval_required";
} | null {
  const record = readObjectContent(event);
  if (
    record.type !== "run_item_stream_event" ||
    record.name !== "tool_output"
  ) {
    return null;
  }
  const item = readObjectContent(record.item);
  const rawItem = readObjectContent(item.rawItem);
  const id =
    readToolCallId(rawItem) ??
    readToolCallId(item) ??
    `tool_${crypto.randomUUID().replaceAll("-", "")}`;
  const name =
    stringField(rawItem, "name") ?? stringField(item, "name") ?? "tool";
  const output = stringifyToolOutput(item.output ?? rawItem.output);
  const parsedOutput = parseToolOutput(output);
  return {
    id,
    name,
    output,
    status: parsedOutput.approvalRequired === true ? "approval_required" : "ok",
  };
}

// Reads SDK approval stream events and maps them back to Kodeks approval records.
function readAgentsSdkApproval(
  event: RunStreamEvent,
  approvalState: Map<string, AgentsSdkApprovalMetadata>,
): AgentsSdkApprovalMetadata | null {
  const record = readObjectContent(event);
  if (
    record.type !== "run_item_stream_event" ||
    record.name !== "tool_approval_requested"
  ) {
    return null;
  }
  return approvalFromSdkItem(record.item, approvalState);
}

// Maps an SDK approval interruption to the matching durable approval metadata.
function approvalFromSdkItem(
  item: unknown,
  approvalState: Map<string, AgentsSdkApprovalMetadata>,
): AgentsSdkApprovalMetadata | null {
  const record = readObjectContent(item);
  const rawItem = readObjectContent(record.rawItem);
  const toolCallId = readToolCallId(rawItem) ?? readToolCallId(record);
  if (toolCallId === null) {
    return null;
  }
  return (
    approvalState.get(toolCallId) ?? {
      approvalId: toolCallId,
      toolCallId,
      reason: "Tool call requires approval",
    }
  );
}

// Reads OpenAI/Responses function call ids across SDK and wire-format naming variants.
function readToolCallId(item: Record<string, unknown>): string | null {
  return (
    stringField(item, "callId") ??
    stringField(item, "call_id") ??
    stringField(item, "id") ??
    stringField(item, "toolCallId") ??
    null
  );
}

// Parses function-call arguments supplied by the SDK.
function readToolArguments(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === "string") {
    return parseToolOutput(value);
  }
  return readObjectContent(value);
}

// Turns SDK tool output into the string contract consumed by the existing UI.
function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  return output === undefined ? "" : JSON.stringify(output);
}

// Converts final structured SDK output into assistant text when no raw deltas were streamed.
function stringifyFinalOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

// Converts one local registry definition into an OpenAI Agents SDK function tool.
function toAgentsSdkTool(
  definition: ToolDefinition,
  registry: ToolRegistry,
  options: {
    database: KodeksDatabase;
    sessionId: string | null;
    workspaceRoot: string;
    environment?: Record<string, string | undefined>;
    approvalState: Map<string, AgentsSdkApprovalMetadata>;
    strict: boolean;
  },
): FunctionTool {
  return tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters as never,
    strict: options.strict,
    needsApproval:
      definition.name === "run_shell"
        ? async (
            _runContext: unknown,
            rawInput: unknown,
            callId: string | undefined,
          ) => {
            const args =
              typeof rawInput === "object" && rawInput !== null
                ? (rawInput as Record<string, unknown>)
                : {};
            const command =
              typeof args.command === "string" ? args.command : "";
            if (!isDangerousCommand(command)) {
              return false;
            }
            const toolCallId =
              callId ?? `tool_${crypto.randomUUID().replaceAll("-", "")}`;
            const approval = await options.database.approvals.createApproval({
              sessionId: options.sessionId,
              toolCallId,
              command: { command },
              reason: "Command requires approval",
            });
            await options.database.auditLog.record({
              sessionId: options.sessionId,
              eventType: "approval_required",
              payload: { approvalId: approval.id, command },
            });
            options.approvalState.set(toolCallId, {
              approvalId: approval.id,
              toolCallId,
              reason: approval.reason,
            });
            return true;
          }
        : false,
    execute: async (
      rawInput: unknown,
      _runContext: unknown,
      details: { toolCall?: { callId?: string | null } } | undefined,
    ) => {
      const args =
        typeof rawInput === "object" && rawInput !== null
          ? (rawInput as Record<string, unknown>)
          : {};
      const toolCallId = details?.toolCall?.callId ?? null;
      const result = await registry.execute(
        definition.name,
        args,
        new ToolExecutionContext(options.sessionId, toolCallId),
      );
      const memoryService = new KodeksMemoryService({
        database: options.database,
        workspaceRoot: options.workspaceRoot,
        environment: resolveRuntimeEnvironment(options.environment),
      });
      const compactedResult = await compactToolExecutionResult({
        result,
        memoryService,
        sessionId: options.sessionId ?? "session_unknown",
        toolCallId,
        toolName: definition.name,
      });
      if (
        compactedResult.status === "approval_required" &&
        toolCallId !== null
      ) {
        const parsedOutput = parseToolOutput(compactedResult.output);
        options.approvalState.set(toolCallId, {
          approvalId: stringFromParsed(parsedOutput.approvalId),
          toolCallId,
          reason: stringFromParsed(parsedOutput.reason),
        });
      }
      return compactedResult.output;
    },
  });
}

// 统一加载 repo 外用户配置，让 chat runtime 和 memory embedding 共用同一份 endpoint 设置。
function resolveRuntimeEnvironment(
  environment: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return loadModelRuntimeEnv(environment ?? process.env);
}

// Replaces oversized successful tool outputs with memory artifact refs.
async function compactToolExecutionResult(input: {
  result: ToolExecutionResult;
  memoryService: MemoryService;
  sessionId: string;
  toolCallId: string | null;
  toolName: string;
}): Promise<ToolExecutionResult> {
  if (input.result.status !== "completed") {
    return input.result;
  }
  return {
    ...input.result,
    output: await input.memoryService.compactToolResult({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      output: input.result.output,
    }),
  };
}

// Counts recalled memory layers for UI display without exposing full score details.
function countMemoryLayers(
  memoryContext: MemoryContext,
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (memoryContext.profiles.length > 0) {
    counts.profile = memoryContext.profiles.length;
  }
  for (const item of memoryContext.recalledItems) {
    counts[item.layer] = (counts[item.layer] ?? 0) + 1;
  }
  return counts;
}

// Builds mode-specific system instructions for the Agents SDK agent.
function buildAgentInstructions(mode: SessionMode): string {
  if (mode === "plan") {
    return [
      "You are Kodeks Plan Agent.",
      "Reply in the user's language. If the user writes Chinese, reply in Chinese.",
      "Inspect the workspace and produce a short, practical plan.",
      "Structure the final answer with a title, short summary, numbered steps, and a verification note so Kodeks can persist it as a plan artifact.",
      "Use read-only tools for workspace search, memory recall, MCP manifests, and skills when useful.",
      "Use tool calls for workspace facts; keep visible text concise and separate from private reasoning.",
      "Do not mutate files or run shell commands.",
      "Do not reveal hidden reasoning or private scratchpad text.",
      "Do not claim you opened a URL unless a tool result proves it.",
    ].join("\n");
  }
  return [
    "You are Kodeks Build Agent.",
    "Reply in the user's language. If the user writes Chinese, reply in Chinese.",
    "Help with coding tasks by using workspace tools, MCP manifests, skills, memory, and subagents.",
    "Use workspace tools to read files, write files, and run shell commands when that is the right next step.",
    "Use tool calls for workspace facts; keep visible text concise and separate from private reasoning.",
    "Use memory, skills, and subagent tools only when they clearly help the task.",
    "Ask for approval before dangerous shell commands or risky writes.",
    "Do not reveal hidden reasoning or private scratchpad text.",
    'Do not write self-talk like "Let me explore" as the final answer.',
    "Do not claim you opened a URL unless a tool result proves it.",
    "Keep final answers concise: say what changed, how it was verified, and any remaining risk.",
  ].join("\n");
}

// Builds system context for the model client request.
function buildSystemContext(
  mode: SessionMode,
  memoryContext: MemoryContext,
  activePlan: StoredPlanArtifact | null,
  selectedFiles: SelectedWorkspaceFileContext[] = [],
): string {
  const memoryBlock = formatMemoryContextForPrompt(memoryContext);
  const planBlock =
    activePlan === null
      ? "No active plan artifact."
      : formatPlanArtifactForContext(activePlan);
  const selectedFilesBlock = formatSelectedFilesContext(selectedFiles);
  return `${buildAgentInstructions(mode)}\n\nSelected workspace files for this turn:\n${selectedFilesBlock}\n\nRecalled memory:\n${memoryBlock}\n\nActive plan artifact:\n${planBlock}`;
}

// Formats user-selected workspace files as bounded turn context for the model.
function formatSelectedFilesContext(
  selectedFiles: SelectedWorkspaceFileContext[],
): string {
  if (selectedFiles.length === 0) {
    return "No files selected.";
  }
  const lines = [
    "The user explicitly selected these workspace files. Use them as high-priority context when relevant. If a file is truncated or an answer needs more detail, call read_file with its path.",
  ];
  for (const file of selectedFiles) {
    lines.push(`\n--- ${file.path}${file.truncated ? " (truncated)" : ""} ---`);
    if (file.error !== undefined) {
      lines.push(`Unable to read selected file: ${file.error}`);
      continue;
    }
    lines.push(file.content ?? "");
  }
  return lines.join("\n");
}

// Formats layered memory into a compact prompt block with artifact refs instead of large bodies.
function formatMemoryContextForPrompt(memoryContext: MemoryContext): string {
  const lines = [];
  for (const profile of memoryContext.profiles) {
    lines.push(`- [profile:${profile.scope}] ${profile.content}`);
  }
  for (const memory of memoryContext.recalledItems) {
    lines.push(`- [${memory.layer}:${memory.scope}] ${memory.content}`);
  }
  for (const artifact of memoryContext.artifactRefs) {
    lines.push(
      `- [artifact:${artifact.refId}] ${artifact.summary} (use read_memory_artifact to inspect full output)`,
    );
  }
  return lines.length === 0 ? "No recalled memories." : lines.join("\n");
}

// Creates an empty layered memory context for direct agent construction tests.
function emptyMemoryContext(): MemoryContext {
  return {
    profiles: [],
    recalledItems: [],
    artifactRefs: [],
  };
}

// Converts a plan artifact into compact context that can be resumed in later turns.
function formatPlanArtifactForContext(plan: StoredPlanArtifact): string {
  const steps = plan.steps
    .map((step) => `- [${step.status}] ${step.title}`)
    .join("\n");
  return [`${plan.title} (${plan.id})`, plan.summary, steps]
    .filter(Boolean)
    .join("\n");
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

// Reads object-shaped message content without forcing callers to trust SQLite JSON.
function readObjectContent(content: unknown): Record<string, unknown> {
  return content !== null &&
    typeof content === "object" &&
    !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : {};
}

// Reads one optional string field from stored message content.
function stringField(
  content: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = content[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Reads persisted tool calls while discarding malformed historical entries.
function readToolCalls(value: unknown): ChatMessage["toolCalls"] {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const calls = value.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") {
      return [];
    }
    return [
      {
        id: record.id,
        name: record.name,
        args: readObjectContent(record.args),
      },
    ];
  });
  return calls.length > 0 ? calls : undefined;
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
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
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
