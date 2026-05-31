import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KodeksDatabase } from "@kodeks/storage";
import { WorkspaceService } from "@kodeks/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildAgentsSdkBuildAgent,
  runChatTurn,
  type AgentEvent,
  type AgentsSdkRunner,
  type AgentsSdkStreamResult,
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnStreamEvent,
  type RunChatTurnInput,
} from "./index";

let tempDir: string;
let database: KodeksDatabase;
let workspace: WorkspaceService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kodeks-runtime-"));
  database = new KodeksDatabase(join(tempDir, "kodeks.sqlite3"));
  workspace = new WorkspaceService(tempDir);
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("runChatTurn", () => {
  it("streams text events and stores resumable transcript", async () => {
    const model = new FakeModelClient([
      [
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: " world" },
        { type: "response_completed", responseId: "resp_1" },
      ],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "hello",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Hello", sessionId: "s1" },
      { type: "text_delta", text: " world", sessionId: "s1" },
      { type: "response_completed", sessionId: "s1", responseId: "resp_1" },
    ]);
    expect(await database.sessions.getTranscript("s1")).toEqual([
      expect.objectContaining({ role: "user", content: { text: "hello" } }),
      expect.objectContaining({
        role: "assistant",
        content: { text: "Hello world", responseId: "resp_1" },
      }),
    ]);
  });

  it("passes the latest stored response id to model clients when stateful Responses is enabled", async () => {
    const firstModel = new FakeModelClient([
      [
        { type: "text_delta", text: "Hello" },
        { type: "response_completed", responseId: "resp_1" },
      ],
    ]);
    await collectEvents(
      runIsolatedChatTurn({
        input: "hello",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model: firstModel,
      }),
    );

    const secondModel = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_2" }],
    ]);
    await collectEvents(
      runIsolatedChatTurn({
        input: "continue",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model: secondModel,
        environment: { KODEKS_RESPONSES_STATEFUL: "true" },
      }),
    );

    expect(secondModel.requests[0]?.previousResponseId).toBe("resp_1");
  });

  it("executes tool calls and emits tool result events", async () => {
    const model = new FakeModelClient([
      [
        {
          type: "tool_call",
          id: "call_1",
          name: "write_file",
          args: { path: "notes.txt", content: "from tool" },
        },
      ],
      [{ type: "response_completed", responseId: "resp_2" }],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "write a note",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    expect(events).toEqual([
      {
        type: "assistant_status",
        message: "Using write_file",
        sessionId: "s1",
      },
      {
        type: "tool_call",
        id: "call_1",
        name: "write_file",
        args: { path: "notes.txt", content: "from tool" },
        sessionId: "s1",
      },
      expect.objectContaining({
        type: "tool_result",
        id: "call_1",
        name: "write_file",
        status: "ok",
        sessionId: "s1",
      }),
      { type: "response_completed", sessionId: "s1", responseId: "resp_2" },
    ]);
    await expect(workspace.readFile("notes.txt")).resolves.toBe("from tool");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
    });
    expect(model.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          args: { path: "notes.txt", content: "from tool" },
        },
      ],
    });
    expect(await database.sessions.getTranscript("s1")).toEqual([
      expect.objectContaining({
        role: "user",
        content: { text: "write a note" },
      }),
      expect.objectContaining({
        role: "assistant",
        content: expect.objectContaining({
          text: "",
          toolCalls: [
            {
              id: "call_1",
              name: "write_file",
              args: { path: "notes.txt", content: "from tool" },
            },
          ],
        }),
      }),
      expect.objectContaining({
        role: "tool",
        content: expect.objectContaining({
          toolCallId: "call_1",
          name: "write_file",
        }),
      }),
    ]);
  });

  it("replays persisted DeepSeek reasoning content after a tool-call turn", async () => {
    const firstModel = new FakeModelClient([
      [
        { type: "text_delta", text: "I'll inspect first." },
        {
          type: "tool_call",
          id: "call_1",
          name: "read_file",
          args: { path: "README.md" },
          reasoningContent: "Need the README before answering.",
        },
      ],
      [
        { type: "text_delta", text: "Done." },
        { type: "response_completed", responseId: "resp_tool_done" },
      ],
    ]);

    await collectEvents(
      runIsolatedChatTurn({
        input: "read the README",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model: firstModel,
      }),
    );

    const secondModel = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_resume" }],
    ]);
    await collectEvents(
      runIsolatedChatTurn({
        input: "continue",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model: secondModel,
      }),
    );

    expect(secondModel.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "I'll inspect first.",
          reasoningContent: "Need the README before answering.",
          toolCalls: [
            {
              id: "call_1",
              name: "read_file",
              args: { path: "README.md" },
            },
          ],
        }),
        expect.objectContaining({
          role: "tool",
          toolCallId: "call_1",
          name: "read_file",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "Done.",
        }),
        expect.objectContaining({
          role: "user",
          content: "continue",
        }),
      ]),
    );
  });

  it("pauses after approval-required tool results instead of sending orphan tool messages", async () => {
    const model = new FakeModelClient([
      [
        {
          type: "tool_call",
          id: "call_shell",
          name: "run_shell",
          args: { command: "cat package.json | head" },
        },
      ],
      [{ type: "response_completed", responseId: "should_not_run" }],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "run a command",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    expect(events).toEqual([
      {
        type: "assistant_status",
        message: "Using run_shell",
        sessionId: "s1",
      },
      {
        type: "tool_call",
        id: "call_shell",
        name: "run_shell",
        args: { command: "cat package.json | head" },
        sessionId: "s1",
      },
      expect.objectContaining({
        type: "tool_result",
        id: "call_shell",
        name: "run_shell",
        status: "approval_required",
        sessionId: "s1",
      }),
      expect.objectContaining({
        type: "approval_required",
        toolCallId: "call_shell",
        sessionId: "s1",
      }),
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("filters mutating tools in plan mode", async () => {
    const model = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_3" }],
    ]);

    await collectEvents(
      runIsolatedChatTurn({
        input: "make a plan",
        sessionId: "s1",
        mode: "plan",
        workspace,
        database,
        model,
      }),
    );

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "grep",
      "recall_memory",
      "read_memory_artifact",
      "spawn_explore_agent",
      "list_mcp_servers",
      "list_skills",
      "read_skill",
    ]);
    expect(await database.sessions.getSession("s1")).toMatchObject({
      mode: "plan",
    });
  });

  it("injects explicitly selected workspace files into the model context", async () => {
    const model = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_selected" }],
    ]);

    await collectEvents(
      runIsolatedChatTurn({
        input: "use the selected file",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        selectedFiles: [
          {
            path: "src/example.ts",
            content: "export const selectedMarker = true;",
          },
        ],
        model,
      }),
    );

    expect(model.requests[0]?.messages[0]?.content).toContain(
      "Selected workspace files for this turn",
    );
    expect(model.requests[0]?.messages[0]?.content).toContain("src/example.ts");
    expect(model.requests[0]?.messages[0]?.content).toContain("selectedMarker");
    await expect(database.sessions.getTranscript("s1")).resolves.toEqual([
      expect.objectContaining({
        role: "user",
        content: { text: "use the selected file" },
      }),
    ]);
  });

  it("creates and persists a structured plan artifact in plan mode", async () => {
    const model = new FakeModelClient([
      [
        {
          type: "text_delta",
          text: "# Storage plan\n\nPersist a plan artifact.\n\n1. Add a plans table\n2. Restore it next turn",
        },
        { type: "response_completed", responseId: "resp_plan" },
      ],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "make a plan for plan artifacts",
        sessionId: "s1",
        mode: "plan",
        workspace,
        database,
        model,
      }),
    );

    expect(events).toEqual([
      {
        type: "text_delta",
        text: "# Storage plan\n\nPersist a plan artifact.\n\n1. Add a plans table\n2. Restore it next turn",
        sessionId: "s1",
      },
      expect.objectContaining({
        type: "plan_artifact",
        action: "created",
        sessionId: "s1",
        plan: expect.objectContaining({
          title: "Storage plan",
          summary: "Persist a plan artifact.",
          steps: [
            {
              id: "step_1",
              title: "Add a plans table",
              status: "pending",
              details: null,
            },
            {
              id: "step_2",
              title: "Restore it next turn",
              status: "pending",
              details: null,
            },
          ],
        }),
      }),
      { type: "response_completed", sessionId: "s1", responseId: "resp_plan" },
    ]);
    await expect(
      database.plans.getActiveBySession("s1"),
    ).resolves.toMatchObject({
      title: "Storage plan",
      summary: "Persist a plan artifact.",
      steps: [
        { id: "step_1", title: "Add a plans table" },
        { id: "step_2", title: "Restore it next turn" },
      ],
    });
  });

  it("recovers the active plan artifact in later turns for the same session", async () => {
    await database.plans.upsertActive({
      sessionId: "s1",
      title: "Recovered plan",
      summary: "Keep the next turn aligned with the stored plan.",
      steps: [
        {
          id: "step_1",
          title: "Use the active plan in context",
          status: "pending",
          details: null,
        },
      ],
    });
    const model = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_resume_plan" }],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "continue from the plan",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    expect(events[0]).toMatchObject({
      type: "plan_artifact",
      action: "recovered",
      sessionId: "s1",
      plan: expect.objectContaining({ title: "Recovered plan" }),
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Recovered plan"),
    });
  });

  it("injects recalled memory before model execution", async () => {
    await database.memories.remember({
      scope: "project",
      content: "Kodeks uses plan mode for read-only planning.",
    });
    const model = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_4" }],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "how should plan mode work?",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    expect(events[0]).toMatchObject({
      type: "memory_recalled",
      sessionId: "s1",
      memoryIds: [expect.stringMatching(/^matom_/)],
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Kodeks uses plan mode"),
    });
  });

  it("offloads large tool outputs before continuing the model turn", async () => {
    await workspace.writeFile("large.txt", "memory artifact body ".repeat(400));
    const model = new FakeModelClient([
      [
        {
          type: "tool_call",
          id: "call_large",
          name: "read_file",
          args: { path: "large.txt" },
        },
      ],
      [{ type: "response_completed", responseId: "resp_large" }],
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "read the large file",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );
    const toolEvent = events.find((event) => event.type === "tool_result") as
      | Extract<AgentEvent, { type: "tool_result" }>
      | undefined;
    const output =
      toolEvent === undefined ? {} : (JSON.parse(toolEvent.output) as unknown);
    const outputRecord =
      output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : {};

    expect(outputRecord).toMatchObject({
      offloaded: true,
      toolName: "read_file",
    });
    expect(JSON.stringify(outputRecord).length).toBeLessThan(1000);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining("read_memory_artifact"),
    });
  });

  it("builds a simple coding-agent system prompt contract", async () => {
    const model = new FakeModelClient([
      [{ type: "response_completed", responseId: "resp_prompt" }],
    ]);

    await collectEvents(
      runIsolatedChatTurn({
        input: "请帮我看一下这个文件",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model,
      }),
    );

    const systemPrompt = model.requests[0]?.messages[0]?.content ?? "";
    expect(systemPrompt).toContain("You are Kodeks");
    expect(systemPrompt).toContain("Reply in the user's language");
    expect(systemPrompt).toContain("Do not reveal hidden reasoning");
    expect(systemPrompt).toContain("read files");
    expect(systemPrompt).toContain("write files");
    expect(systemPrompt).toContain("run shell commands");
    expect(systemPrompt).toContain("Do not claim you opened a URL");
  });

  it("uses OpenAI Agents SDK as the primary runtime when configured", async () => {
    const runner = new FakeAgentsSdkRunner([
      {
        type: "raw_model_stream_event",
        data: { type: "output_text_delta", delta: "Hello" },
      },
      {
        type: "raw_model_stream_event",
        data: { type: "output_text_delta", delta: " from SDK" },
      },
    ]);

    const events = await collectEvents(
      runIsolatedChatTurn({
        input: "hello",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        agents: {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5.4-mini",
          reasoningEffort: "medium",
          runner,
        },
      }),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Hello", sessionId: "s1" },
      { type: "text_delta", text: " from SDK", sessionId: "s1" },
      {
        type: "response_completed",
        sessionId: "s1",
        responseId: "resp_agents",
      },
    ]);
    expect((runner.agent as { name?: string } | undefined)?.name).toBe(
      "Kodeks Build Agent",
    );
    expect(runner.input).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.anything(),
      }),
    ]);
    await expect(database.sessions.getTranscript("s1")).resolves.toEqual([
      expect.objectContaining({ role: "user", content: { text: "hello" } }),
      expect.objectContaining({
        role: "assistant",
        content: { text: "Hello from SDK", responseId: "resp_agents" },
      }),
    ]);
  });
});

describe("buildAgentsSdkBuildAgent", () => {
  it("constructs an OpenAI Agents SDK agent with local tool wrappers", () => {
    const agent = buildAgentsSdkBuildAgent({
      workspace,
      database,
      mode: "act",
      model: "gpt-5.4-mini",
    });

    expect(agent.name).toBe("Kodeks Build Agent");
    expect(agent.tools.map((tool) => tool.name)).toContain("read_file");
  });

  it("can opt SDK function tools into strict mode without changing defaults", () => {
    const defaultAgent = buildAgentsSdkBuildAgent({
      workspace,
      database,
      mode: "act",
      model: "gpt-5.4-mini",
    }) as unknown as { tools: Array<{ strict?: boolean }> };
    const strictAgent = buildAgentsSdkBuildAgent({
      workspace,
      database,
      mode: "act",
      model: "gpt-5.4-mini",
      environment: { KODEKS_STRICT_TOOL_SCHEMAS: "true" },
    }) as unknown as { tools: Array<{ strict?: boolean }> };

    expect(defaultAgent.tools.every((tool) => tool.strict !== true)).toBe(true);
    expect(strictAgent.tools.some((tool) => tool.strict === true)).toBe(true);
  });

  it("turns dangerous run_shell calls into SDK approval interruptions with durable records", async () => {
    const agent = buildAgentsSdkBuildAgent({
      workspace,
      database,
      mode: "act",
      model: "gpt-5.4-mini",
      sessionId: "s1",
    });
    const runShell = agent.tools.find(
      (candidate) => candidate.name === "run_shell",
    ) as
      | {
          needsApproval(
            runContext: never,
            input: { command: string },
            callId: string,
          ): Promise<boolean>;
        }
      | undefined;

    expect(runShell).toBeDefined();
    const needsApproval = await runShell?.needsApproval(
      {} as never,
      { command: "cat package.json | head" } as never,
      "call_shell",
    );

    expect(needsApproval).toBe(true);
    await expect(database.auditLog.listBySession("s1")).resolves.toEqual([
      expect.objectContaining({
        eventType: "approval_required",
        payload: expect.objectContaining({
          command: "cat package.json | head",
        }),
      }),
    ]);
  });
});

class FakeModelClient implements ModelClient {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly turns: ModelTurnStreamEvent[][]) {}

  // Streams preconfigured events while capturing the runtime request.
  async *streamTurn(
    request: ModelTurnRequest,
  ): AsyncIterable<ModelTurnStreamEvent> {
    this.requests.push(request);
    const turnEvents = this.turns[this.requests.length - 1] ?? [];
    for (const event of turnEvents) {
      yield event;
    }
  }
}

class FakeAgentsSdkRunner implements AgentsSdkRunner {
  agent: unknown;
  input: unknown;

  constructor(private readonly events: unknown[]) {}

  // Streams preconfigured SDK-shaped events while capturing the agent and input items.
  async run(agent: never, input: never): Promise<AgentsSdkStreamResult> {
    this.agent = agent;
    this.input = input;
    return {
      completed: Promise.resolve(),
      finalOutput: "Hello from SDK",
      interruptions: [],
      lastResponseId: "resp_agents",
      [Symbol.asyncIterator]: async function* (this: FakeAgentsSdkRunner) {
        for (const event of this.events) {
          yield event as never;
        }
      }.bind(this),
    } as AgentsSdkStreamResult;
  }
}

// Runs runtime tests with user-level config and embeddings disabled for deterministic isolation.
function runIsolatedChatTurn(
  input: RunChatTurnInput,
): AsyncIterable<AgentEvent> {
  return runChatTurn({
    ...input,
    environment: {
      KODEKS_CONFIG_PATH: join(tempDir, "missing-kodeks-config.json"),
      KODEKS_EMBEDDINGS_ENABLED: "false",
      ...input.environment,
    },
  });
}

// Collects one async event stream into an array for assertions.
async function collectEvents(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
