import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_TEXT_FILE_BYTES = 1_000_000;
const DEFAULT_LIST_CACHE_TTL_MS = 1_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

const BLOCKED_PATH_PARTS = new Set([
  ".git",
  ".kodeks",
  ".venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".DS_Store"
]);

const DANGEROUS_PATTERNS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
  /\bsudo\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\bwget\b.*\|\s*(sh|bash)\b/i,
  /[;&|`$<>]/,
  /(^|[\s'"`])\.\.(\/|$)/,
  /(^|[\s'"`])(\.git|\.kodeks|\.venv|node_modules)(\/|$)/
];

export type ShellResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  approvalRequired: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type RunCommandOptions = {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export class WorkspacePathError extends Error {
  // Names workspace boundary failures for API and tool mapping.
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class ShellCommandTimeoutError extends Error {
  // Names subprocess timeouts for API and tool mapping.
  constructor(command: string) {
    super(`Shell command timed out: ${command}`);
    this.name = "ShellCommandTimeoutError";
  }
}

export class WorkspaceService {
  private readonly root: string;
  private readonly maxTextFileBytes: number;
  private readonly listCacheTtlMs: number;
  private fileListCache: { createdAt: number; limit: number | null; files: string[] } | null = null;

  // Creates a workspace service bound to one authorized project root.
  constructor(
    root: string,
    options: {
      maxTextFileBytes?: number;
      listCacheTtlMs?: number;
    } = {}
  ) {
    this.root = resolve(root);
    this.maxTextFileBytes = options.maxTextFileBytes ?? DEFAULT_MAX_TEXT_FILE_BYTES;
    this.listCacheTtlMs = options.listCacheTtlMs ?? DEFAULT_LIST_CACHE_TTL_MS;
  }

  // Returns the authorized workspace root for services that need a cwd.
  rootPath(): string {
    return this.root;
  }

  // Resolves a workspace-relative path and rejects escapes or internal paths.
  resolvePath(relativePath: string): string {
    const target = resolve(this.root, relativePath);
    const relativeTarget = relative(this.root, target);
    if (relativeTarget === "" || isEscapingRelativePath(relativeTarget)) {
      throw new WorkspacePathError("Path escapes workspace");
    }
    if (isBlockedRelativePath(relativeTarget)) {
      throw new WorkspacePathError("Path is blocked");
    }
    return target;
  }

  // Reads a UTF-8 text file from the authorized workspace.
  async readFile(relativePath: string): Promise<string> {
    const target = this.resolvePath(relativePath);
    const fileStat = await stat(target).catch(() => null);
    if (fileStat === null || !fileStat.isFile()) {
      throw new Error(`File not found: ${relativePath}`);
    }
    if (fileStat.size > this.maxTextFileBytes) {
      throw new Error("File is too large");
    }
    return readFile(target, "utf8");
  }

  // Writes UTF-8 text to a workspace file using whole-file overwrite semantics.
  async writeFile(relativePath: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > this.maxTextFileBytes) {
      throw new Error("File is too large");
    }
    const target = this.resolvePath(relativePath);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
    this.invalidateFileListCache();
  }

  // Lists workspace files while pruning blocked internal subtrees.
  async listFiles(options: { limit?: number; refresh?: boolean } = {}): Promise<string[]> {
    const limit = options.limit ?? null;
    const now = Date.now();
    if (
      !options.refresh &&
      this.fileListCache !== null &&
      this.fileListCache.limit === limit &&
      now - this.fileListCache.createdAt <= this.listCacheTtlMs
    ) {
      return [...this.fileListCache.files];
    }

    const files: string[] = [];
    await this.visitDirectory(this.root, files, limit);
    this.fileListCache = {
      createdAt: now,
      limit,
      files: [...files]
    };
    return files;
  }

  // Clears cached file listings after a workspace mutation.
  invalidateFileListCache(): void {
    this.fileListCache = null;
  }

  // Recursively walks a directory and appends visible file paths.
  private async visitDirectory(directory: string, files: string[], limit: number | null): Promise<void> {
    if (limit !== null && files.length >= limit) {
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      if (limit !== null && files.length >= limit) {
        return;
      }
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(this.root, absolutePath);
      if (isBlockedRelativePath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await this.visitDirectory(absolutePath, files, limit);
      } else if (entry.isFile()) {
        files.push(relativePath.split(sep).join("/"));
      }
    }
  }
}

// Returns whether a command must go through human approval.
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

// Runs a command only when it passes the safe-command policy.
export async function runCommand(command: string, options: RunCommandOptions): Promise<ShellResult> {
  if (isDangerousCommand(command)) {
    return {
      command,
      exitCode: null,
      stdout: "",
      stderr: "Command requires approval",
      approvalRequired: true,
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }
  return runParsedCommand(command, options, "Command requires approval");
}

// Runs a command after approval has already been granted by a higher layer.
export async function runApprovedCommand(command: string, options: RunCommandOptions): Promise<ShellResult> {
  return runParsedCommand(command, options, "Approved command could not be parsed");
}

// Parses argv, executes without a shell, and truncates captured output.
async function runParsedCommand(
  command: string,
  options: RunCommandOptions,
  parseFailureMessage: string
): Promise<ShellResult> {
  const args = parseCommandArgs(command);
  if (args === null) {
    return {
      command,
      exitCode: null,
      stdout: "",
      stderr: parseFailureMessage,
      approvalRequired: parseFailureMessage === "Command requires approval",
      stdoutTruncated: false,
      stderrTruncated: false
    };
  }

  try {
    await access(options.cwd, constants.R_OK | constants.X_OK);
    const completed = await execFileAsync(args[0] ?? "", args.slice(1), {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: Math.max((options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) * 4, DEFAULT_MAX_OUTPUT_BYTES)
    });
    const [stdout, stdoutTruncated] = truncateOutput(
      String(completed.stdout ?? ""),
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    );
    const [stderr, stderrTruncated] = truncateOutput(
      String(completed.stderr ?? ""),
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    );
    return {
      command,
      exitCode: 0,
      stdout,
      stderr,
      approvalRequired: false,
      stdoutTruncated,
      stderrTruncated
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ShellCommandTimeoutError(command);
    }
    const processError = error as { code?: number; stdout?: string; stderr?: string };
    const [stdout, stdoutTruncated] = truncateOutput(
      String(processError.stdout ?? ""),
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    );
    const [stderr, stderrTruncated] = truncateOutput(
      String(processError.stderr ?? ""),
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    );
    return {
      command,
      exitCode: typeof processError.code === "number" ? processError.code : 1,
      stdout,
      stderr,
      approvalRequired: false,
      stdoutTruncated,
      stderrTruncated
    };
  }
}

// Parses a shell-like command string into argv without enabling shell interpretation.
function parseCommandArgs(command: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    return null;
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args.length === 0 ? null : args;
}

// Truncates output to a UTF-8 byte limit without splitting characters.
function truncateOutput(text: string, maxBytes: number): [string, boolean] {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return [text, false];
  }
  return [encoded.subarray(0, maxBytes).toString("utf8"), true];
}

// Returns whether a resolved relative path escapes the workspace root.
function isEscapingRelativePath(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith("../");
}

// Returns whether a workspace-relative path points at internal project data.
function isBlockedRelativePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/u)
    .filter(Boolean)
    .some((part) => BLOCKED_PATH_PARTS.has(part));
}

// Detects Node child_process timeout failures across versions.
function isTimeoutError(error: unknown): boolean {
  const maybeError = error as { signal?: string; killed?: boolean; code?: string };
  return maybeError.signal === "SIGTERM" || maybeError.killed === true || maybeError.code === "ETIMEDOUT";
}
