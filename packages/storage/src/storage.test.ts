import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  AuditLogRepository,
  KodeksDatabase,
  MemoryService,
  MemoryRepository,
  PlanRepository,
  SessionRepository,
  SubagentRepository,
} from "./index";

let tempDir: string;
let database: KodeksDatabase;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kodeks-storage-"));
  database = new KodeksDatabase(join(tempDir, "kodeks.sqlite3"));
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionRepository", () => {
  it("returns null for a missing session before creating one", async () => {
    const sessions = new SessionRepository(database);

    await expect(sessions.getSession("missing")).resolves.toBeNull();
  });

  it("creates, lists, resumes, and appends transcript messages", async () => {
    const sessions = new SessionRepository(database);
    const session = await sessions.createSession({
      id: "s1",
      title: "Demo",
      mode: "act",
      workspaceRoot: tempDir,
    });

    await sessions.appendMessage({
      sessionId: session.id,
      role: "user",
      content: { text: "hello" },
    });
    await sessions.appendMessage({
      sessionId: session.id,
      role: "assistant",
      content: { text: "hi" },
      agentEvent: { type: "text_delta", text: "hi" },
    });

    expect(await sessions.getSession("s1")).toMatchObject({
      id: "s1",
      title: "Demo",
      mode: "act",
      workspaceRoot: tempDir,
    });
    expect(await sessions.listSessions()).toHaveLength(1);
    expect(await sessions.getTranscript("s1")).toEqual([
      {
        id: expect.any(String),
        sessionId: "s1",
        role: "user",
        content: { text: "hello" },
        agentEvent: null,
        createdAt: expect.any(String),
      },
      {
        id: expect.any(String),
        sessionId: "s1",
        role: "assistant",
        content: { text: "hi" },
        agentEvent: { type: "text_delta", text: "hi" },
        createdAt: expect.any(String),
      },
    ]);
  });

  it("updates session mode for plan mode transitions", async () => {
    const sessions = new SessionRepository(database);
    await sessions.createSession({
      id: "s1",
      title: "Demo",
      mode: "act",
      workspaceRoot: tempDir,
    });

    await sessions.updateMode("s1", "plan");

    expect(await sessions.getSession("s1")).toMatchObject({
      id: "s1",
      mode: "plan",
    });
  });
});

describe("MemoryRepository", () => {
  it("stores, recalls, and soft deletes scoped memory records", async () => {
    const memories = new MemoryRepository(database);
    const memoryId = await memories.remember({
      scope: "project",
      content: "Kodeks uses SQLite repositories for migration work.",
      sourceSessionId: "s1",
    });
    await memories.remember({
      scope: "user",
      content: "User prefers short Chinese implementation updates.",
    });

    expect(await memories.recall("sqlite migration")).toEqual([
      expect.objectContaining({
        id: memoryId,
        scope: "project",
        content: "Kodeks uses SQLite repositories for migration work.",
        sourceSessionId: "s1",
      }),
    ]);

    await memories.delete(memoryId);

    expect(await memories.recall("sqlite migration")).toEqual([]);
  });

  it("stores layered memory records and recalls them through FTS", async () => {
    const atom = await database.memories.rememberAtom({
      scope: "project",
      content: "TencentDB style memory uses atoms and scenarios.",
      sourceSessionId: "s1",
    });
    const scenario = await database.memories.rememberScenario({
      scope: "project",
      title: "Memory migration",
      summary: "Implement FTS recall for Kodeks memory scenarios.",
      sourceSessionId: "s1",
    });
    await database.memories.rememberProfile({
      scope: "user",
      content: "User prefers Chinese conversation.",
      priority: 5,
    });

    const recalled = await database.memories.recallLayered("memory scenario");

    expect(recalled.atoms).toEqual([
      expect.objectContaining({ id: atom.id, layer: "atom" }),
    ]);
    expect(recalled.scenarios).toEqual([
      expect.objectContaining({ id: scenario.id, layer: "scenario" }),
    ]);
    expect(recalled.profiles).toEqual([
      expect.objectContaining({
        content: "User prefers Chinese conversation.",
      }),
    ]);
  });

  it("caches local embedding vectors by content hash and model", async () => {
    await database.memories.rememberEmbedding({
      contentHash: "hash_1",
      embeddingModel: "embeddinggemma",
      vector: [1, 0.5, 0],
    });

    await expect(
      database.memories.getEmbedding("hash_1", "embeddinggemma"),
    ).resolves.toEqual([1, 0.5, 0]);
  });

  it("offloads large tool output into a memory artifact", async () => {
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      artifactThresholdBytes: 20,
    });

    const output = await service.compactToolResult({
      sessionId: "s1",
      toolCallId: "call_1",
      toolName: "grep",
      output: "large output ".repeat(10),
    });
    const parsed = JSON.parse(output) as { refId: string; offloaded: boolean };
    const artifact = await database.memories.readArtifactContent(parsed.refId);

    expect(parsed.offloaded).toBe(true);
    expect(artifact?.content).toContain("large output");
  });

  it("falls back to FTS-only context when Ollama embeddings are unavailable", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content: "Plan mode memory can be recalled without embeddings.",
    });
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "ollama",
      },
      fetch: async () => {
        throw new Error("ollama unavailable");
      },
    });

    const context = await service.buildContext({
      sessionId: "s1",
      query: "plan mode memory",
    });

    expect(context.recalledItems).toEqual([
      expect.objectContaining({
        layer: "atom",
        content: "Plan mode memory can be recalled without embeddings.",
      }),
    ]);
  });

  it("reranks recalled memory with Ollama embeddings when available", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content: "Plan mode memory uses read-only tool filters.",
    });
    const embeddedInputs: string[] = [];
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "ollama",
        KODEKS_OLLAMA_EMBED_MODEL: "embeddinggemma",
      },
      fetch: async (_url, init) => {
        const body = JSON.parse(init?.body ?? "{}") as { input?: string };
        embeddedInputs.push(body.input ?? "");
        return {
          ok: true,
          async json() {
            return { embeddings: [[1, 0, 0]] };
          },
        };
      },
    });

    const context = await service.buildContext({
      sessionId: "s1",
      query: "plan mode",
    });

    expect(embeddedInputs).toEqual([
      "plan mode",
      "Plan mode memory uses read-only tool filters.",
    ]);
    expect(context.recalledItems[0]?.score.semantic).toBeGreaterThan(0);
  });

  it("smoke tests no-download local embeddings without calling a network provider", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content:
        "TencentDB memory evaluation should not require model downloads.",
    });
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "local",
      },
      fetch: async () => {
        throw new Error("local embeddings should not call fetch");
      },
    });

    const context = await service.buildContext({
      sessionId: "s1",
      query: "TencentDB memory model downloads",
    });

    expect(context.recalledItems).toEqual([
      expect.objectContaining({
        layer: "atom",
        content:
          "TencentDB memory evaluation should not require model downloads.",
      }),
    ]);
    expect(context.recalledItems[0]?.score.semantic).toBeGreaterThan(0);
  });

  it("caches injected embedding provider vectors for repeat memory recall", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content:
        "Injectable embedding providers keep tests independent from Ollama.",
    });
    const embeddedInputs: string[] = [];
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "test",
        KODEKS_LOCAL_EMBED_MODEL: "unit-vector-v1",
      },
      embeddingProvider: async ({ text }) => {
        embeddedInputs.push(text);
        return [1, 0];
      },
    });

    await service.buildContext({
      sessionId: "s1",
      query: "Ollama independent tests",
    });
    await service.buildContext({
      sessionId: "s1",
      query: "Ollama independent tests",
    });

    expect(embeddedInputs).toEqual([
      "Ollama independent tests",
      "Injectable embedding providers keep tests independent from Ollama.",
    ]);
  });

  it("supports Hugging Face feature-extraction compatible embedding fallback", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content:
        "Remote embedding fallback can use Hugging Face feature extraction.",
    });
    const requests: Array<{
      url: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "huggingface",
        KODEKS_HUGGINGFACE_BASE_URL: "https://hf.example.test",
        KODEKS_HUGGINGFACE_EMBED_MODEL: "org/embed-model",
        KODEKS_HUGGINGFACE_API_TOKEN: "hf_test",
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init?.body ?? "{}"),
          authorization: init?.headers?.authorization,
        });
        return {
          ok: true,
          async json() {
            return [
              [0, 1, 0],
              [0, 1, 0],
            ];
          },
        };
      },
    });

    const context = await service.buildContext({
      sessionId: "s1",
      query: "Hugging Face feature extraction",
    });

    expect(requests[0]).toEqual({
      url: "https://hf.example.test/pipeline/feature-extraction/org/embed-model",
      body: {
        inputs: "Hugging Face feature extraction",
        normalize: true,
        truncate: true,
      },
      authorization: "Bearer hf_test",
    });
    expect(context.recalledItems[0]?.score.semantic).toBeGreaterThan(0);
  });

  it("supports LM Studio OpenAI-compatible embedding endpoints", async () => {
    await database.memories.rememberAtom({
      scope: "project",
      content:
        "LM Studio can serve Qwen3 embeddings through an OpenAI-compatible endpoint.",
    });
    const requests: Array<{
      url: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const service = new MemoryService({
      database,
      workspaceRoot: tempDir,
      environment: {
        KODEKS_EMBEDDINGS_ENABLED: "true",
        KODEKS_EMBEDDINGS_PROVIDER: "lmstudio",
        KODEKS_LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
        KODEKS_LMSTUDIO_EMBED_MODEL: "Qwen/Qwen3-Embedding-0.6B",
        KODEKS_LMSTUDIO_API_KEY: "lm-studio",
      },
      fetch: async (url, init) => {
        requests.push({
          url,
          body: JSON.parse(init?.body ?? "{}"),
          authorization: init?.headers?.authorization,
        });
        return {
          ok: true,
          async json() {
            return {
              data: [
                {
                  embedding: [1, 0, 0],
                },
              ],
            };
          },
        };
      },
    });

    const context = await service.buildContext({
      sessionId: "s1",
      query: "Qwen3 embeddings in LM Studio",
    });

    expect(requests[0]).toEqual({
      url: "http://127.0.0.1:1234/v1/embeddings",
      body: {
        model: "Qwen/Qwen3-Embedding-0.6B",
        input: "Qwen3 embeddings in LM Studio",
        encoding_format: "float",
      },
      authorization: "Bearer lm-studio",
    });
    expect(context.recalledItems[0]?.score.semantic).toBeGreaterThan(0);
  });
});

describe("ApprovalRepository", () => {
  it("creates approval records and enforces one-shot decisions", async () => {
    const approvals = database.approvals;
    const approval = await approvals.createApproval({
      sessionId: "s1",
      toolCallId: "call_1",
      command: { command: "rm -rf output" },
      reason: "dangerous command",
    });

    expect(await approvals.getApproval(approval.id)).toMatchObject({
      id: approval.id,
      status: "pending",
      reason: "dangerous command",
    });

    await approvals.approve(approval.id);
    await approvals.markExecuted(approval.id);
    await expect(approvals.approve(approval.id)).rejects.toBeInstanceOf(
      ApprovalAlreadyResolvedError,
    );
    await expect(
      approvals.reject(approval.id, "too late"),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
    await expect(approvals.getApproval(approval.id)).resolves.toMatchObject({
      status: "executed",
    });
    await expect(approvals.getApproval("missing")).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
  });
});

describe("SubagentRepository", () => {
  it("records subagent lifecycle summaries", async () => {
    const subagents = new SubagentRepository(database);
    const run = await subagents.startRun({
      parentSessionId: "s1",
      agentName: "explore",
      task: "inspect storage",
    });

    await subagents.completeRun(run.id, "storage is ready");

    expect(await subagents.getRun(run.id)).toMatchObject({
      id: run.id,
      parentSessionId: "s1",
      agentName: "explore",
      task: "inspect storage",
      summary: "storage is ready",
      status: "completed",
    });
  });
});

describe("PlanRepository", () => {
  it("stores one active structured plan per session and archives older plans", async () => {
    const plans = new PlanRepository(database);
    const firstPlan = await plans.upsertActive({
      sessionId: "s1",
      title: "Initial plan",
      summary: "Inspect files before editing.",
      steps: [
        {
          id: "step_1",
          title: "Read runtime",
          status: "pending",
          details: null,
        },
      ],
      sourceMessageId: "msg_1",
    });
    const secondPlan = await plans.upsertActive({
      sessionId: "s1",
      title: "Updated plan",
      summary: "Persist plan artifacts.",
      steps: [
        {
          id: "step_1",
          title: "Add storage table",
          status: "completed",
          details: "SQLite repository",
        },
        {
          id: "step_2",
          title: "Emit recovery event",
          status: "pending",
          details: null,
        },
      ],
    });

    expect(await plans.getActiveBySession("s1")).toMatchObject({
      id: secondPlan.id,
      sessionId: "s1",
      title: "Updated plan",
      steps: [
        {
          id: "step_1",
          title: "Add storage table",
          status: "completed",
          details: "SQLite repository",
        },
        {
          id: "step_2",
          title: "Emit recovery event",
          status: "pending",
          details: null,
        },
      ],
      status: "active",
    });
    expect(await plans.listBySession("s1")).toEqual([
      expect.objectContaining({ id: secondPlan.id, status: "active" }),
      expect.objectContaining({ id: firstPlan.id, status: "archived" }),
    ]);
  });
});

describe("AuditLogRepository", () => {
  it("appends auditable JSON payloads in order", async () => {
    const auditLog = new AuditLogRepository(database);

    await auditLog.record({
      sessionId: "s1",
      eventType: "approval_required",
      payload: { command: "rm -rf output" },
    });

    expect(await auditLog.listBySession("s1")).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        eventType: "approval_required",
        payload: { command: "rm -rf output" },
      }),
    ]);
  });
});
