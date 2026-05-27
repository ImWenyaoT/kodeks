import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  AuditLogRepository,
  KodeksDatabase,
  MemoryRepository,
  SessionRepository,
  SubagentRepository
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
      workspaceRoot: tempDir
    });

    await sessions.appendMessage({
      sessionId: session.id,
      role: "user",
      content: { text: "hello" }
    });
    await sessions.appendMessage({
      sessionId: session.id,
      role: "assistant",
      content: { text: "hi" },
      agentEvent: { type: "text_delta", text: "hi" }
    });

    expect(await sessions.getSession("s1")).toMatchObject({
      id: "s1",
      title: "Demo",
      mode: "act",
      workspaceRoot: tempDir
    });
    expect(await sessions.listSessions()).toHaveLength(1);
    expect(await sessions.getTranscript("s1")).toEqual([
      {
        id: expect.any(String),
        sessionId: "s1",
        role: "user",
        content: { text: "hello" },
        agentEvent: null,
        createdAt: expect.any(String)
      },
      {
        id: expect.any(String),
        sessionId: "s1",
        role: "assistant",
        content: { text: "hi" },
        agentEvent: { type: "text_delta", text: "hi" },
        createdAt: expect.any(String)
      }
    ]);
  });

  it("updates session mode for plan mode transitions", async () => {
    const sessions = new SessionRepository(database);
    await sessions.createSession({
      id: "s1",
      title: "Demo",
      mode: "act",
      workspaceRoot: tempDir
    });

    await sessions.updateMode("s1", "plan");

    expect(await sessions.getSession("s1")).toMatchObject({
      id: "s1",
      mode: "plan"
    });
  });
});

describe("MemoryRepository", () => {
  it("stores, recalls, and soft deletes scoped memory records", async () => {
    const memories = new MemoryRepository(database);
    const memoryId = await memories.remember({
      scope: "project",
      content: "Kodeks uses SQLite repositories for migration work.",
      sourceSessionId: "s1"
    });
    await memories.remember({
      scope: "user",
      content: "User prefers short Chinese implementation updates."
    });

    expect(await memories.recall("sqlite migration")).toEqual([
      expect.objectContaining({
        id: memoryId,
        scope: "project",
        content: "Kodeks uses SQLite repositories for migration work.",
        sourceSessionId: "s1"
      })
    ]);

    await memories.delete(memoryId);

    expect(await memories.recall("sqlite migration")).toEqual([]);
  });
});

describe("ApprovalRepository", () => {
  it("creates approval records and enforces one-shot decisions", async () => {
    const approvals = database.approvals;
    const approval = await approvals.createApproval({
      sessionId: "s1",
      toolCallId: "call_1",
      command: { command: "rm -rf output" },
      reason: "dangerous command"
    });

    expect(await approvals.getApproval(approval.id)).toMatchObject({
      id: approval.id,
      status: "pending",
      reason: "dangerous command"
    });

    await approvals.approve(approval.id);
    await approvals.markExecuted(approval.id);
    await expect(approvals.approve(approval.id)).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
    await expect(approvals.reject(approval.id, "too late")).rejects.toBeInstanceOf(
      ApprovalAlreadyResolvedError
    );
    await expect(approvals.getApproval(approval.id)).resolves.toMatchObject({ status: "executed" });
    await expect(approvals.getApproval("missing")).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });
});

describe("SubagentRepository", () => {
  it("records subagent lifecycle summaries", async () => {
    const subagents = new SubagentRepository(database);
    const run = await subagents.startRun({
      parentSessionId: "s1",
      agentName: "explore",
      task: "inspect storage"
    });

    await subagents.completeRun(run.id, "storage is ready");

    expect(await subagents.getRun(run.id)).toMatchObject({
      id: run.id,
      parentSessionId: "s1",
      agentName: "explore",
      task: "inspect storage",
      summary: "storage is ready",
      status: "completed"
    });
  });
});

describe("AuditLogRepository", () => {
  it("appends auditable JSON payloads in order", async () => {
    const auditLog = new AuditLogRepository(database);

    await auditLog.record({
      sessionId: "s1",
      eventType: "approval_required",
      payload: { command: "rm -rf output" }
    });

    expect(await auditLog.listBySession("s1")).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        eventType: "approval_required",
        payload: { command: "rm -rf output" }
      })
    ]);
  });
});
