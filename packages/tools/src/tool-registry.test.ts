import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KodeksDatabase } from "@kodeks/storage";
import { WorkspaceService } from "@kodeks/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolExecutionContext, buildDefaultToolRegistry } from "./index";

let tempDir: string;
let database: KodeksDatabase;
let workspace: WorkspaceService;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "kodeks-tools-"));
  database = new KodeksDatabase(join(tempDir, "kodeks.sqlite3"));
  workspace = new WorkspaceService(tempDir);
});

afterEach(async () => {
  database.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("ToolRegistry", () => {
  it("returns stable tool definitions and filters read-only tools for plan mode", () => {
    const registry = buildDefaultToolRegistry({ workspace, database });

    expect(registry.definitions().map((definition) => definition.name)).toEqual([
      "read_file",
      "write_file",
      "grep",
      "run_shell",
      "remember_fact",
      "recall_memory",
      "spawn_explore_agent"
    ]);
    expect(registry.definitions({ readOnlyOnly: true }).map((definition) => definition.name)).toEqual([
      "read_file",
      "grep",
      "recall_memory",
      "spawn_explore_agent"
    ]);
  });

  it("executes read_file and write_file through workspace boundaries", async () => {
    const registry = buildDefaultToolRegistry({ workspace, database });

    const writeResult = await registry.execute("write_file", {
      path: "notes/demo.md",
      content: "hello"
    });
    const readResult = await registry.execute("read_file", { path: "notes/demo.md" });
    const blockedResult = await registry.execute("read_file", { path: ".git/config" });

    expect(writeResult.status).toBe("completed");
    expect(JSON.parse(writeResult.output)).toMatchObject({
      ok: true,
      path: "notes/demo.md",
      strategy: "whole_file_overwrite"
    });
    expect(JSON.parse(readResult.output)).toMatchObject({
      ok: true,
      content: "hello"
    });
    expect(blockedResult.status).toBe("failed");
  });

  it("greps visible workspace files and ignores blocked internals", async () => {
    const registry = buildDefaultToolRegistry({ workspace, database });
    await workspace.writeFile("src/a.ts", "export const marker = 'kodeks';");
    await workspace.writeFile("src/b.ts", "nothing here");

    const result = await registry.execute("grep", { query: "kodeks" });

    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      matches: [{ path: "src/a.ts", line: 1, text: "export const marker = 'kodeks';" }]
    });
  });

  it("turns dangerous shell commands into approval records", async () => {
    const registry = buildDefaultToolRegistry({ workspace, database });
    const result = await registry.execute(
      "run_shell",
      { command: "rm -rf output" },
      new ToolExecutionContext("s1", "call_1")
    );
    const output = JSON.parse(result.output);

    expect(result.status).toBe("approval_required");
    expect(output).toMatchObject({
      ok: false,
      approvalRequired: true,
      status: "pending",
      command: "rm -rf output"
    });
    await expect(database.approvals.getApproval(output.approvalId)).resolves.toMatchObject({
      sessionId: "s1",
      toolCallId: "call_1",
      status: "pending"
    });
  });

  it("stores and recalls memory facts", async () => {
    const registry = buildDefaultToolRegistry({ workspace, database });

    const rememberResult = await registry.execute(
      "remember_fact",
      {
        content: "Kodeks plan mode is read only.",
        scope: "project"
      },
      new ToolExecutionContext("s1", "call_1")
    );
    const recallResult = await registry.execute("recall_memory", {
      query: "plan mode",
      limit: 2
    });

    expect(JSON.parse(rememberResult.output)).toMatchObject({ ok: true, scope: "project" });
    expect(JSON.parse(recallResult.output).memories).toEqual([
      expect.objectContaining({
        content: "Kodeks plan mode is read only.",
        sourceSessionId: "s1"
      })
    ]);
  });

  it("records read-only explore subagent runs", async () => {
    const registry = buildDefaultToolRegistry({ workspace, database });
    const result = await registry.execute(
      "spawn_explore_agent",
      { task: "inspect workspace package" },
      new ToolExecutionContext("s1", "call_1")
    );
    const output = JSON.parse(result.output);

    expect(result.status).toBe("completed");
    expect(output).toMatchObject({
      ok: true,
      status: "completed",
      summary: "Explore agent completed task: inspect workspace package"
    });
    await expect(database.subagents.getRun(output.runId)).resolves.toMatchObject({
      parentSessionId: "s1",
      agentName: "explore",
      status: "completed"
    });
  });
});
