import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { KodeksDatabase } from '@kodeks/storage';
import { ShellCommandTimeoutError, runCommand } from '@kodeks/workspace';
import type { WorkspaceService } from '@kodeks/workspace';

import { defaultToolDefinitions, type ToolDefinition } from './definitions';

export { defaultToolDefinitions, type ToolDefinition } from './definitions';

export type ToolExecutionStatus = 'completed' | 'failed' | 'approval_required';

export type ToolExecutionResult = {
  status: ToolExecutionStatus;
  output: string;
};

export type RegisteredTool = {
  definition: ToolDefinition;
  readOnly: boolean;
  mutating: boolean;
  handler: (
    arguments_: Record<string, unknown>,
    context: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
};

export type ToolRegistryServices = {
  workspace: WorkspaceService;
  database: KodeksDatabase;
  environment?: Record<string, string | undefined>;
  fetch?: FetchLike;
};

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

type McpServerManifest = {
  label: string;
  url: string;
  allowedTools: string[];
  skipApproval: boolean;
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
      .filter(
        (tool) => !options.readOnlyOnly || (tool.readOnly && !tool.mutating)
      )
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
export function buildDefaultToolRegistry(
  services: ToolRegistryServices
): ToolRegistry {
  return new ToolRegistry([
    {
      definition: defaultToolDefinitions[0],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeReadFile(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[1],
      readOnly: false,
      mutating: true,
      handler: (arguments_) => executeWriteFile(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[2],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeGrep(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[3],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeWebSearch(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[4],
      readOnly: false,
      mutating: true,
      handler: (arguments_, context) =>
        executeRunShell(arguments_, context, services)
    },
    {
      definition: defaultToolDefinitions[5],
      readOnly: false,
      mutating: true,
      handler: (arguments_, context) =>
        executeRememberFact(arguments_, context, services)
    },
    {
      definition: defaultToolDefinitions[6],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeRecallMemory(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[7],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeReadMemoryArtifact(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[8],
      readOnly: true,
      mutating: false,
      handler: (arguments_, context) =>
        executeSpawnExploreAgent(arguments_, context, services)
    },
    {
      definition: defaultToolDefinitions[9],
      readOnly: true,
      mutating: false,
      handler: () => executeListMcpServers(services)
    },
    {
      definition: defaultToolDefinitions[10],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeListSkills(arguments_, services)
    },
    {
      definition: defaultToolDefinitions[11],
      readOnly: true,
      mutating: false,
      handler: (arguments_) => executeReadSkill(arguments_, services)
    }
  ]);
}

// Executes read_file through the shared workspace boundary.
async function executeReadFile(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const path = stringArgument(arguments_, 'path');
  if (path === null) {
    return failedOutput('read_file requires a non-empty string path');
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
  const path = stringArgument(arguments_, 'path');
  const content = stringArgument(arguments_, 'content', { allowEmpty: true });
  if (path === null) {
    return failedOutput('write_file requires a non-empty string path');
  }
  if (content === null) {
    return failedOutput('write_file requires string content', { path });
  }
  try {
    await services.workspace.writeFile(path, content);
    return completedOutput({
      ok: true,
      path,
      strategy: 'whole_file_overwrite',
      bytesWritten: Buffer.byteLength(content, 'utf8')
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
  const query = stringArgument(arguments_, 'query');
  const rawLimit = arguments_.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : 20;
  if (query === null) {
    return failedOutput('grep requires a non-empty string query');
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
        matches.push({ path, line: index + 1, text: lines[index] ?? '' });
      }
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return completedOutput({ ok: true, query, matches });
}

// Executes Brave web search and returns a compact source list.
async function executeWebSearch(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const query = stringArgument(arguments_, 'query');
  if (query === null) {
    return failedOutput('web_search requires a non-empty string query');
  }

  const environment = services.environment ?? process.env;
  const apiKey = environment.BRAVE_SEARCH_API_KEY ?? environment.BRAVE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return failedOutput(
      'Brave Search is not configured. Set BRAVE_SEARCH_API_KEY to enable web_search.',
      {
        query
      }
    );
  }

  const fetchClient = services.fetch ?? globalThis.fetch;
  if (fetchClient === undefined) {
    return failedOutput('No fetch implementation is available for web_search', {
      query
    });
  }

  const count = clampInteger(arguments_.count, 1, 10, 5);
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  const country = stringArgument(arguments_, 'country');
  if (country !== null) {
    url.searchParams.set('country', country.toUpperCase());
  }

  const response = await fetchClient(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  });
  if (!response.ok) {
    return failedOutput(
      `Brave Search failed with ${response.status} ${response.statusText}`,
      { query }
    );
  }

  const payload = await response.json();
  const results = readBraveResults(payload);
  return completedOutput({
    ok: true,
    provider: 'brave',
    query,
    results
  });
}

// Executes run_shell and records approval requests for dangerous commands.
async function executeRunShell(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const command = stringArgument(arguments_, 'command');
  if (command === null) {
    return failedOutput('run_shell requires a non-empty string command');
  }
  try {
    const result = await runCommand(command, {
      cwd: services.workspace.rootPath()
    });
    if (result.approvalRequired) {
      const approval = await services.database.approvals.createApproval({
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        command: { command },
        reason: result.stderr
      });
      await services.database.auditLog.record({
        sessionId: context.sessionId,
        eventType: 'approval_required',
        payload: { approvalId: approval.id, command }
      });
      return {
        status: 'approval_required',
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
      return failedOutput('Command timed out');
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
  const content = stringArgument(arguments_, 'content');
  const scope = stringArgument(arguments_, 'scope') ?? 'project';
  if (content === null) {
    return failedOutput('remember_fact requires non-empty string content');
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
  const query = stringArgument(arguments_, 'query');
  const rawLimit = arguments_.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : 5;
  if (query === null) {
    return failedOutput('recall_memory requires a non-empty string query');
  }
  const layers = readMemoryLayers(arguments_.layers);
  const layered = await services.database.memories.recallLayered(
    query,
    limit,
    layers
  );
  const memories = await services.database.memories.recall(query, limit);
  return completedOutput({ ok: true, query, layers, memories, layered });
}

// Executes read_memory_artifact through the memory repository.
async function executeReadMemoryArtifact(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const refId = stringArgument(arguments_, 'refId');
  if (refId === null) {
    return failedOutput('read_memory_artifact requires a non-empty string refId');
  }
  const artifact = await services.database.memories.readArtifactContent(refId);
  if (artifact === null) {
    return failedOutput(`Unknown memory artifact: ${refId}`, { refId });
  }
  return completedOutput({
    ok: true,
    refId,
    artifact: artifact.artifact,
    content: artifact.content
  });
}

// Executes a minimal read-only explore subagent run.
async function executeSpawnExploreAgent(
  arguments_: Record<string, unknown>,
  context: ToolExecutionContext,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const task = stringArgument(arguments_, 'task');
  if (task === null) {
    return failedOutput('spawn_explore_agent requires a non-empty string task');
  }
  const run = await services.database.subagents.startRun({
    parentSessionId: context.sessionId ?? 'session_unknown',
    agentName: 'explore',
    task
  });
  const summary = `Explore agent completed task: ${task}`;
  const completedRun = await services.database.subagents.completeRun(
    run.id,
    summary
  );
  return completedOutput({
    ok: true,
    runId: completedRun.id,
    status: completedRun.status,
    summary: completedRun.summary
  });
}

// Lists configured MCP server manifests without opening external connections.
async function executeListMcpServers(
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const servers = readMcpServerManifests(services.environment ?? process.env);
  return completedOutput({
    ok: true,
    servers,
    count: servers.length
  });
}

// Lists available skill directories and their first markdown heading.
async function executeListSkills(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const query = stringArgument(arguments_, 'query');
  const limit = clampInteger(arguments_.limit, 1, 50, 20);
  const skills = await discoverSkills(services);
  const filtered =
    query === null
      ? skills
      : skills.filter((skill) =>
          `${skill.name}\n${skill.title}`
            .toLowerCase()
            .includes(query.toLowerCase())
        );
  return completedOutput({
    ok: true,
    skills: filtered.slice(0, limit)
  });
}

// Reads a discovered skill body by exact directory name.
async function executeReadSkill(
  arguments_: Record<string, unknown>,
  services: ToolRegistryServices
): Promise<ToolExecutionResult> {
  const name = stringArgument(arguments_, 'name');
  if (name === null) {
    return failedOutput('read_skill requires a non-empty string name');
  }
  const skills = await discoverSkills(services);
  const skill = skills.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    return failedOutput(`Unknown skill: ${name}`);
  }
  const content = await readFile(skill.path, 'utf8');
  return completedOutput({
    ok: true,
    name: skill.name,
    title: skill.title,
    content
  });
}

// Reads a required string argument from model-provided JSON.
function stringArgument(
  arguments_: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string | null {
  const value = arguments_[name];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) {
    return null;
  }
  return options.allowEmpty ? value : trimmed;
}

// Reads and clamps a numeric argument from model-provided JSON.
function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

// Reads optional memory layer filters from model-provided JSON.
function readMemoryLayers(value: unknown): Array<'atom' | 'scenario' | 'artifact'> {
  if (!Array.isArray(value)) {
    return ['atom', 'scenario', 'artifact'];
  }
  const layers = value.filter(
    (item): item is 'atom' | 'scenario' | 'artifact' =>
      item === 'atom' || item === 'scenario' || item === 'artifact'
  );
  return layers.length === 0 ? ['atom', 'scenario', 'artifact'] : layers;
}

// Converts Brave's larger response payload into a stable small result shape.
function readBraveResults(
  payload: unknown
): Array<{ title: string; url: string; description: string }> {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return [];
  }
  const web = (payload as { web?: unknown }).web;
  if (web === null || typeof web !== 'object' || Array.isArray(web)) {
    return [];
  }
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.flatMap((result) => {
    if (
      result === null ||
      typeof result !== 'object' ||
      Array.isArray(result)
    ) {
      return [];
    }
    const record = result as Record<string, unknown>;
    if (typeof record.title !== 'string' || typeof record.url !== 'string') {
      return [];
    }
    return [
      {
        title: record.title,
        url: record.url,
        description:
          typeof record.description === 'string' ? record.description : ''
      }
    ];
  });
}

// Reads MCP server manifests from environment variables without requiring a live MCP client yet.
function readMcpServerManifests(
  environment: Record<string, string | undefined>
): McpServerManifest[] {
  const rawServers = environment.KODEKS_MCP_SERVERS;
  if (rawServers !== undefined && rawServers.trim().length > 0) {
    return parseMcpServerManifests(rawServers);
  }

  const url = environment.KODEKS_MCP_SERVER_URL;
  if (url === undefined || url.trim().length === 0) {
    return [];
  }
  return [
    {
      label: environment.KODEKS_MCP_SERVER_LABEL ?? 'default',
      url: url.trim(),
      allowedTools: splitCsv(environment.KODEKS_MCP_ALLOWED_TOOLS),
      skipApproval: environment.KODEKS_MCP_SKIP_APPROVAL === 'true'
    }
  ];
}

// Parses a JSON MCP server manifest while discarding malformed entries.
function parseMcpServerManifests(rawServers: string): McpServerManifest[] {
  try {
    const parsed = JSON.parse(rawServers) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return [];
      }
      const record = item as Record<string, unknown>;
      if (typeof record.label !== 'string' || typeof record.url !== 'string') {
        return [];
      }
      const allowedTools = Array.isArray(record.allowedTools)
        ? record.allowedTools.filter(
            (tool): tool is string => typeof tool === 'string'
          )
        : splitCsv(
            typeof record.allowedTools === 'string'
              ? record.allowedTools
              : undefined
          );
      return [
        {
          label: record.label,
          url: record.url,
          allowedTools,
          skipApproval: record.skipApproval === true
        }
      ];
    });
  } catch {
    return [];
  }
}

// Splits comma-separated environment values into non-empty tokens.
function splitCsv(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

// Discovers SKILL.md files from configured roots.
async function discoverSkills(
  services: ToolRegistryServices
): Promise<Array<{ name: string; title: string; path: string }>> {
  const roots = skillRoots(services);
  const skills = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(root, entry.name, 'SKILL.md');
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content === null) {
        continue;
      }
      skills.push({
        name: entry.name,
        title: readMarkdownTitle(content) ?? entry.name,
        path
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

// Resolves skill roots from env or the workspace-local default.
function skillRoots(services: ToolRegistryServices): string[] {
  const environment = services.environment ?? process.env;
  const configured = splitCsv(environment.KODEKS_SKILLS_PATHS);
  const roots =
    configured.length > 0
      ? configured
      : [join(services.workspace.rootPath(), '.kodeks', 'skills')];
  return roots.map((root) => resolve(root.replace(/^~/u, homedir())));
}

// Reads the first markdown heading as the skill title.
function readMarkdownTitle(content: string): string | null {
  const heading = content.split(/\r?\n/u).find((line) => line.startsWith('# '));
  return heading === undefined ? null : heading.replace(/^#\s+/u, '').trim();
}

// Creates a successful JSON tool result.
function completedOutput(
  payload: Record<string, unknown>
): ToolExecutionResult {
  return {
    status: 'completed',
    output: jsonOutput(payload)
  };
}

// Creates a failed JSON tool result.
function failedOutput(
  message: string,
  extra: Record<string, unknown> = {}
): ToolExecutionResult {
  return {
    status: 'failed',
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
