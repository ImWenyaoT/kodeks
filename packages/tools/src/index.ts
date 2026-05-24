import type { KodeksDatabase } from "@kodeks/storage";
import {
  ShellCommandTimeoutError,
  WorkspaceService,
  runCommand
} from "@kodeks/workspace";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolExecutionStatus = "completed" | "failed" | "approval_required";

export type ToolExecutionResult = {
  status: ToolExecutionStatus;
  output: string;
};

export type RegisteredTool = {
  definition: ToolDefinition;
  readOnly: boolean;
  mutating: boolean;
  handler: (arguments_: Record<string, unknown>, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
};

export type ToolRegistryServices = {
  workspace: WorkspaceService;
  database: KodeksDatabase;
};

export class ToolExecutionContext {
  // Carries session/tool-call ids into approval and audit records.
  constructor(
    readonly sessionId: string | null = null,
    readonly toolCallId: string | null = null
  ) {}
}

export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool>;

  // Stores deterministic tool definitions and handlers by public tool name.
  constructor(tools: RegisteredTool[]) {
    this.tools = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  // Returns provider-facing definitions in stable registration order.
  definitions(options: { readOnlyOnly?: boolean } = {}): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !options.readOnlyOnly || (tool.readOnly && !tool.mutating))
      .map((tool) => tool.definition);
  }

  // Executes a registered tool and turns unknown names into model-readable failures.
  async execute(
    toolName: string,
    arguments_: Record<string, unknown>,
    context = new ToolExecutionContext()
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      return failedOutput(`Unknown tool: ${toolName}`);
    }
    return tool.handler(arguments_, context);
  }
}

// Builds the MVP tool registry from deterministic local services.
export function buildDefaultToolRegistry(services: ToolRegistryServices): ToolRegistry {
  return new ToolRegistry([
    {
      definition: readFileDefinition(),
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeReadFile(arguments_, services)
    },
    {
      definition: writeFileDefinition(),
      readOnly: false,
      mutating: true,
      handler: (arguments_) => executeWriteFile(arguments_, services)
    },
    {
      definition: grepDefinition(),
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeGrep(arguments_, services)
    },
    {
      definition: runShellDefinition(),
      readOnly: false,
      mutating: true,
      handler: (arguments_, context) => executeRunShell(arguments_, context, services)
    },
    {
      definition: rememberFactDefinition(),
      readOnly: false,
      mutating: true,
      handler: (arguments_, context) => executeRememberFact(arguments_, context, services)
    },
    {
      definition: recallMemoryDefinition(),
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeRecallMemory(arguments_, services)
    },
    {
      definition: spawnExploreAgentDefinition(),
      readOnly: true,
      mutating: false,
      handler: (arguments_, context) => executeSpawnExploreAgent(arguments_, context, services)
    }
  ]);
}

// Defines the read_file tool schema exposed to the model.
function readFileDefinition(): ToolDefinition {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file from the authorized workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  };
}

// Defines the write_file tool schema exposed to the model.
function writeFileDefinition(): ToolDefinition {
  return {
    name: "write_file",
    description: "Write UTF-8 text to a workspace file using whole-file overwrite semantics.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  };
}

// Defines the grep tool schema exposed to the model.
function grepDefinition(): ToolDefinition {
  return {
    name: "grep",
    description: "Search visible workspace text files for a literal query.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" }
      },
      required: ["query"]
    }
  };
}

// Defines the run_shell tool schema exposed to the model.
function runShellDefinition(): ToolDefinition {
  return {
    name: "run_shell",
    description: "Run a safe command in the workspace or request approval for dangerous commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" }
      },
      required: ["command"]
    }
  };
}

// Defines the remember_fact tool schema exposed to the model.
function rememberFactDefinition(): ToolDefinition {
  return {
    name: "remember_fact",
    description: "Save one explicit memory fact.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        scope: { type: "string" }
      },
      required: ["content"]
    }
  };
}

// Defines the recall_memory tool schema exposed to the model.
function recallMemoryDefinition(): ToolDefinition {
  return {
    name: "recall_memory",
    description: "Recall relevant memory facts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" }
      },
      required: ["query"]
    }
  };
}

// Defines the spawn_explore_agent tool schema exposed to the model.
function spawnExploreAgentDefinition(): ToolDefinition {
  return {
    name: "spawn_explore_agent",
    description: "Run one read-only explore subagent task and return its compact summary.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" }
      },
      required: ["task"]
    }
  };
}

// Executes read_file through the shared workspace boundary.
async function executeReadFile(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const path = stringArgument(arguments_, "path");
  if (path === null) {
    return failedOutput("read_file requires a non-empty string path");
  }
  try {
    const content = await services.workspace.readFile(path);
    return completedOutput({ ok: true, path, content });
  } catch (error) {
    return failedOutput(errorMessage(error), { path });
  }
}

// Executes write_file with whole-file overwrite semantics.
async function executeWriteFile(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const path = stringArgument(arguments_, "path");
  const content = stringArgument(arguments_, "content", { allowEmpty: true });
  if (path === null) {
    return failedOutput("write_file requires a non-empty string path");
  }
  if (content === null) {
    return failedOutput("write_file requires string content", { path });
  }
  try {
    await services.workspace.writeFile(path, content);
    return completedOutput({
      ok: true,
      path,
      strategy: "whole_file_overwrite",
      bytesWritten: Buffer.byteLength(content, "utf8")
    });
  } catch (error) {
    return failedOutput(errorMessage(error), { path });
  }
}

// Executes a literal workspace grep over visible text files.
async function executeGrep(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const query = stringArgument(arguments_, "query");
  const rawLimit = arguments_.limit;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 20;
  if (query === null) {
    return failedOutput("grep requires a non-empty string query");
  }
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const path of await services.workspace.listFiles()) {
    if (matches.length >= limit) {
      break;
    }
    const content = await services.workspace.readFile(path).catch(() => null);
    if (content === null) {
      continue;
    }
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]?.includes(query)) {
        matches.push({ path, line: index + 1, text: lines[index] ?? "" });
      }
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return completedOutput({ ok: true, query, matches });
}

// Executes run_shell and records approval requests for dangerous commands.
async function executeRunShell(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const command = stringArgument(arguments_, "command");
  if (command === null) {
    return failedOutput("run_shell requires a non-empty string command");
  }
  try {
    const result = await runCommand(command, { cwd: services.workspace.rootPath() });
    if (result.approvalRequired) {
      const approval = await services.database.approvals.createApproval({
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        command: { command },
        reason: result.stderr
      });
      await services.database.auditLog.record({
        sessionId: context.sessionId,
        eventType: "approval_required",
        payload: { approvalId: approval.id, command }
      });
      return {
        status: "approval_required",
        output: jsonOutput({
          ok: false,
          approvalRequired: true,
          approvalId: approval.id,
          status: approval.status,
          reason: approval.reason,
          command
        })
      };
    }
    return completedOutput({
      ok: result.exitCode === 0,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      approvalRequired: false
    });
  } catch (error) {
    if (error instanceof ShellCommandTimeoutError) {
      return failedOutput("Command timed out");
    }
    return failedOutput(errorMessage(error));
  }
}

// Executes remember_fact through the memory repository.
async function executeRememberFact(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const content = stringArgument(arguments_, "content");
  const scope = stringArgument(arguments_, "scope") ?? "project";
  if (content === null) {
    return failedOutput("remember_fact requires non-empty string content");
  }
  const memoryId = await services.database.memories.remember({
    scope,
    content,
    sourceSessionId: context.sessionId
  });
  return completedOutput({ ok: true, memoryId, scope, content });
}

// Executes recall_memory through the memory repository.
async function executeRecallMemory(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const query = stringArgument(arguments_, "query");
  const rawLimit = arguments_.limit;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? rawLimit : 5;
  if (query === null) {
    return failedOutput("recall_memory requires a non-empty string query");
  }
  const memories = await services.database.memories.recall(query, limit);
  return completedOutput({ ok: true, query, memories });
}

// Executes a minimal read-only explore subagent run.
async function executeSpawnExploreAgent(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const task = stringArgument(arguments_, "task");
  if (task === null) {
    return failedOutput("spawn_explore_agent requires a non-empty string task");
  }
  const run = await services.database.subagents.startRun({
    parentSessionId: context.sessionId ?? "session_unknown",
    agentName: "explore",
    task
  });
  const summary = `Explore agent completed task: ${task}`;
  const completedRun = await services.database.subagents.completeRun(run.id, summary);
  return completedOutput({
    ok: true,
    runId: completedRun.id,
    status: completedRun.status,
    summary: completedRun.summary
  });
}

// Reads a required string argument from model-provided JSON.
function stringArgument(
  arguments_: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | null {
  const value = arguments_[name];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) {
    return null;
  }
  return options.allowEmpty ? value : trimmed;
}

// Creates a successful JSON tool result.
function completedOutput(payload: Record<string, unknown>): ToolExecutionResult {
  return {
    status: "completed",
    output: jsonOutput(payload)
  };
}

// Creates a failed JSON tool result.
function failedOutput(message: string, extra: Record<string, unknown> = {}): ToolExecutionResult {
  return {
    status: "failed",
    output: jsonOutput({
      ok: false,
      error: message,
      ...extra
    })
  };
}

// Serializes tool outputs compactly for model-facing tool messages.
function jsonOutput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// Converts unknown thrown values into readable tool errors.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
