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
  type ModelClient,
  type ModelTurnRequest,
  type ModelTurnStreamEvent
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
    const model = new FakeModelClient([[
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "response_completed", responseId: "resp_1" }
    ]]);

    const events = await collectEvents(
      runChatTurn({
        input: "hello",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model
      })
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Hello", sessionId: "s1" },
      { type: "text_delta", text: " world", sessionId: "s1" },
      { type: "response_completed", sessionId: "s1", responseId: "resp_1" }
    ]);
    expect(await database.sessions.getTranscript("s1")).toEqual([
      expect.objectContaining({ role: "user", content: { text: "hello" } }),
      expect.objectContaining({ role: "assistant", content: { text: "Hello world" } })
    ]);
  });

  it("executes tool calls and emits tool result events", async () => {
    const model = new FakeModelClient([
      [
        {
          type: "tool_call",
          id: "call_1",
          name: "write_file",
          args: { path: "notes.txt", content: "from tool" }
        }
      ],
      [{ type: "response_completed", responseId: "resp_2" }]
    ]);

    const events = await collectEvents(
      runChatTurn({
        input: "write a note",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model
      })
    );

    expect(events).toEqual([
      {
        type: "assistant_status",
        message: "Using write_file",
        sessionId: "s1"
      },
      {
        type: "tool_call",
        id: "call_1",
        name: "write_file",
        args: { path: "notes.txt", content: "from tool" },
        sessionId: "s1"
      },
      expect.objectContaining({
        type: "tool_result",
        id: "call_1",
        name: "write_file",
        status: "ok",
        sessionId: "s1"
      }),
      { type: "response_completed", sessionId: "s1", responseId: "resp_2" }
    ]);
    await expect(workspace.readFile("notes.txt")).resolves.toBe("from tool");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call_1"
    });
    expect(model.requests[1]?.messages.at(-2)).toMatchObject({
      role: "assistant",
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          args: { path: "notes.txt", content: "from tool" }
        }
      ]
    });
  });

  it("pauses after approval-required tool results instead of sending orphan tool messages", async () => {
    const model = new FakeModelClient([
      [
        {
          type: "tool_call",
          id: "call_shell",
          name: "run_shell",
          args: { command: "cat package.json | head" }
        }
      ],
      [{ type: "response_completed", responseId: "should_not_run" }]
    ]);

    const events = await collectEvents(
      runChatTurn({
        input: "run a command",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model
      })
    );

    expect(events).toEqual([
      {
        type: "assistant_status",
        message: "Using run_shell",
        sessionId: "s1"
      },
      {
        type: "tool_call",
        id: "call_shell",
        name: "run_shell",
        args: { command: "cat package.json | head" },
        sessionId: "s1"
      },
      expect.objectContaining({
        type: "tool_result",
        id: "call_shell",
        name: "run_shell",
        status: "approval_required",
        sessionId: "s1"
      }),
      expect.objectContaining({
        type: "approval_required",
        toolCallId: "call_shell",
        sessionId: "s1"
      })
    ]);
    expect(model.requests).toHaveLength(1);
  });

  it("filters mutating tools in plan mode", async () => {
    const model = new FakeModelClient([[{ type: "response_completed", responseId: "resp_3" }]]);

    await collectEvents(
      runChatTurn({
        input: "make a plan",
        sessionId: "s1",
        mode: "plan",
        workspace,
        database,
        model
      })
    );

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "grep",
      "recall_memory",
      "spawn_explore_agent"
    ]);
    expect(await database.sessions.getSession("s1")).toMatchObject({ mode: "plan" });
  });

  it("injects recalled memory before model execution", async () => {
    await database.memories.remember({
      scope: "project",
      content: "Kodeks uses plan mode for read-only planning."
    });
    const model = new FakeModelClient([[{ type: "response_completed", responseId: "resp_4" }]]);

    const events = await collectEvents(
      runChatTurn({
        input: "how should plan mode work?",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model
      })
    );

    expect(events[0]).toMatchObject({
      type: "memory_recalled",
      sessionId: "s1",
      memoryIds: [expect.stringMatching(/^mem_/)]
    });
    expect(model.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("Kodeks uses plan mode")
    });
  });

  it("builds a simple coding-agent system prompt contract", async () => {
    const model = new FakeModelClient([[{ type: "response_completed", responseId: "resp_prompt" }]]);

    await collectEvents(
      runChatTurn({
        input: "请帮我看一下这个文件",
        sessionId: "s1",
        mode: "act",
        workspace,
        database,
        model
      })
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
});

describe("buildAgentsSdkBuildAgent", () => {
  it("constructs an OpenAI Agents SDK agent with local tool wrappers", () => {
    const agent = buildAgentsSdkBuildAgent({
      workspace,
      database,
      mode: "act",
      model: "gpt-5.4-mini"
    });

    expect(agent.name).toBe("Kodeks Build Agent");
    expect(agent.tools.map((tool) => tool.name)).toContain("read_file");
  });
});

class FakeModelClient implements ModelClient {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly turns: ModelTurnStreamEvent[][]) {}

  // Streams preconfigured events while capturing the runtime request.
  async *streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent> {
    this.requests.push(request);
    const turnEvents = this.turns[this.requests.length - 1] ?? [];
    for (const event of turnEvents) {
      yield event;
    }
  }
}

// Collects one async event stream into an array for assertions.
async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
