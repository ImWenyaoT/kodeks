// frontend/lib/server/workspace.ts
// Workspace 沙箱与 shell 安全策略：逐字节忠实移植自 Python src/kodeks/workspace.py。
// 路径黑名单 + 越界检测、危险命令正则（12 条）、无 shell argv 解析、10s 超时 / 64KB 字节截断。
//
// 保真红线（见 50-tools-security.md §2、保真风险 3/6/7/10/11/16）：
//  · BLOCKED_PATH_PARTS / BLOCKED_FILENAME_PREFIXES 逐字；resolvePath 越界与黑名单判定顺序固定。
//  · DANGEROUS_PATTERNS 12 条逐字（含 rm -rf 两条乱序、[;&|`$<>]、.. 与内部目录前缀分组），全部 /i。
//  · 判定顺序：shell-only 先于 dangerous（[;&|`$<>] 同时命中两表，但 shell-only 先返回，不审批）。
//  · parseCommandArgs 自实现引号分词（仅 '/" 引号、空白分隔、未闭合→null），不用 shell-quote 库。
//  · listFiles 排序+剪枝：dir 与 file 名均排序，原地剪枝黑名单目录避免下钻，POSIX 相对路径，limit 截断。
//  · 写入/字节截断按 UTF-8 字节（Buffer.byteLength），不是 string.length。
import { type Dirent, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  type Executor,
  ExecutorTimeoutError,
  LocalExecutor,
} from './execution/executor'

/** 任一路径段命中即拒绝的内部/生成目录名集合（移植 BLOCKED_PATH_PARTS，workspace.py:11-24）。 */
export const BLOCKED_PATH_PARTS: ReadonlySet<string> = new Set([
  '.git',
  '.idea',
  '.kodeks',
  '.ruff_cache',
  '.uv-cache',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.DS_Store',
  '__pycache__',
  'dist',
  'node_modules',
])

/** 文件名以这些前缀开头即拒绝（移植 BLOCKED_FILENAME_PREFIXES，workspace.py:26）。覆盖 .env / .env.local 等。 */
export const BLOCKED_FILENAME_PREFIXES: readonly string[] = ['.env']

/**
 * 危险命令正则（12 条，全部 IGNORECASE→/i），逐字移植 DANGEROUS_PATTERNS（workspace.py:28-44）。
 * 关键：rm -rf 用两条乱序正则匹配 flag 顺序（r..f / f..r）；[;&|`$<>] 字符类含反引号；
 * .. 与内部目录用 (^|[\s'"`]) 前缀分组。正则字面量直接照搬 Python 字符串（已是 RegExp 语法）。
 */
export const DANGEROUS_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
  /\bsudo\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\bcurl\b.*\|\s*(sh|bash)\b/i,
  /\bwget\b.*\|\s*(sh|bash)\b/i,
  /[;&|`$<>]/i,
  /(^|[\s'"`])\.\.(\/|$)/i,
  /(^|[\s'"`])(\.git|\.kodeks|\.venv|node_modules)(\/|$)/i,
]

/** shell-only 语法字符类（移植 SHELL_ONLY_SYNTAX，workspace.py:45）。 */
export const SHELL_ONLY_SYNTAX = /[;&|`$<>]/

/** 命中 shell-only 语法时返回的逐字错误文案（移植 SHELL_ONLY_ERROR，workspace.py:46-50）。 */
export const SHELL_ONLY_ERROR =
  'run_shell executes commands without a shell; remove pipes, redirects, ' +
  'command substitutions, variables, or control operators and call one ' +
  'executable with plain arguments.'

/** 需要审批的可执行文件名：它们能绕过文件工具边界或隐式运行脚本。 */
const APPROVAL_EXECUTABLES: ReadonlySet<string> = new Set([
  'bash',
  'bun',
  'cmd',
  'curl',
  'deno',
  'fish',
  'node',
  'npm',
  'npx',
  'perl',
  'php',
  'pnpm',
  'pwsh',
  'python',
  'python2',
  'python3',
  'ruby',
  'sh',
  'wget',
  'yarn',
  'zsh',
])

/** 解释器 inline 代码参数；命中时必须走用户审批。 */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(['-c', '-e', '--eval'])

/** 路径越界或命中黑名单时抛出（移植 WorkspacePathError，workspace.py:53-54）。 */
export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspacePathError'
  }
}

/** 子进程超时时抛出（移植 ShellCommandTimeoutError，workspace.py:57-58）。 */
export class ShellCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellCommandTimeoutError'
  }
}

/**
 * 审批感知的 shell 执行结果（移植 ShellResult dataclass，workspace.py:61-84）。
 * toWire 输出 camelCase 字段，顺序逐字对齐 Python to_wire。
 */
export class ShellResult {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly approvalRequired: boolean,
    readonly stdoutTruncated: boolean,
    readonly stderrTruncated: boolean,
  ) {}

  /** 用既有 camelCase 字段名序列化（移植 to_wire，workspace.py:73-84），键顺序逐字。 */
  toWire(): {
    command: string
    exitCode: number | null
    stdout: string
    stderr: string
    approvalRequired: boolean
    stdoutTruncated: boolean
    stderrTruncated: boolean
  } {
    return {
      command: this.command,
      exitCode: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      approvalRequired: this.approvalRequired,
      stdoutTruncated: this.stdoutTruncated,
      stderrTruncated: this.stderrTruncated,
    }
  }
}

/**
 * 判断一个文件名是否内部/生成/密钥型（移植 _is_blocked_workspace_filename，workspace.py:155-160）。
 * name ∈ BLOCKED_PATH_PARTS 或 name 以任一 BLOCKED_FILENAME_PREFIXES 前缀开头。
 */
function isBlockedWorkspaceFilename(name: string): boolean {
  return (
    BLOCKED_PATH_PARTS.has(name) ||
    BLOCKED_FILENAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

/**
 * 判断一个相对路径是否指向隐藏运行时内部（移植 _is_blocked_workspace_path，workspace.py:163-168）。
 * 任一路径段在黑名单 或 任一段是被阻断文件名。parts 由 POSIX/系统分隔符切分（不含空段）。
 */
function isBlockedWorkspacePath(parts: readonly string[]): boolean {
  return (
    parts.some((part) => BLOCKED_PATH_PARTS.has(part)) ||
    parts.some((part) => isBlockedWorkspaceFilename(part))
  )
}

/**
 * 把一个相对路径拆成非空路径段（对应 Python Path(relative).parts，剔除空段与 '.'）。
 * Node path.relative 在同目录用 sep 切分即可；空字符串/根本身返回空数组。
 */
function pathParts(relativePath: string): string[] {
  return relativePath.split(/[\\/]/).filter((part) => part.length > 0 && part !== '.')
}

/**
 * 解析路径的真实形态（跟随符号链接）；对不存在的尾部按词法拼接——复刻 Python `Path.resolve(strict=False)`。
 * 词法 `path.resolve` 不跟随符号链接,故工作区内的目录符号链接（如 `link -> /etc`）能逃逸边界;
 * 这里把已存在的最长前缀解析为真实路径、再拼回不存在的尾部,用于做"真实路径"越界判定。
 */
function realResolveExisting(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length > 0 ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        // 上溯到文件系统根仍无可解析项（理论上 '/' 总能解析）；回退为词法 target。
        return target
      }
      tail.push(basename(current))
      current = parent
    }
  }
}

/** 限定在单一授权项目根内的文件与列举访问（移植 WorkspaceService，workspace.py:87-152）。 */
export class WorkspaceService {
  /** 解析后的绝对工作区根。 */
  readonly root: string
  /** 单文件读写的最大 UTF-8 字节上限（默认 1_000_000，workspace.py:91）。 */
  readonly maxTextFileBytes: number

  /**
   * @param root 工作区根目录（构造时 resolve 成绝对路径）。
   * @param maxTextFileBytes 单文件读写字节上限（默认 1MB）。
   */
  constructor(root: string, maxTextFileBytes = 1_000_000) {
    this.root = resolve(root)
    this.maxTextFileBytes = maxTextFileBytes
  }

  /** 返回绝对授权工作区根（移植 root_path，workspace.py:96-99）。 */
  rootPath(): string {
    return this.root
  }

  /**
   * 解析一个工作区相对路径并拒绝越界/内部路径（移植 resolve_path，workspace.py:101-113）。
   * 判定顺序固定：1) resolve 后 relative 越界→"Path escapes workspace"；
   * 2) 等于 root 本身（无路径段）→"Path escapes workspace"；3) 命中黑名单→"Path is blocked"。
   * @returns 解析后的绝对目标路径。
   */
  resolvePath(relativePath: string): string {
    const target = resolve(this.root, relativePath)
    const rel = relative(this.root, target)
    // 越界检测：rel 以 '..' 开头或为绝对路径，即逃逸出 root（对应 Python relative_to 抛 ValueError）。
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
      throw new WorkspacePathError('Path escapes workspace')
    }
    const parts = pathParts(rel)
    // 等于 root 本身（rel 为空）→ Python relative.parts 为空，视为越界。
    if (parts.length === 0) {
      throw new WorkspacePathError('Path escapes workspace')
    }
    if (isBlockedWorkspacePath(parts)) {
      throw new WorkspacePathError('Path is blocked')
    }
    // 符号链接逃逸防护（复刻 Python `Path.resolve()` 跟随符号链接的语义）：
    // 词法越界检查只看路径字面量,工作区内的目录符号链接（如 link -> /etc）可绕过它;
    // 这里把 root 与 target 都解析为真实路径后再判一次越界,堵住这类逃逸。
    let realRoot: string
    try {
      realRoot = realpathSync(this.root)
    } catch {
      // root 尚不存在时退回词法 root（Python resolve 对不存在路径同样按词法处理,不报越界）。
      realRoot = this.root
    }
    const realRel = relative(realRoot, realResolveExisting(target))
    if (realRel.startsWith('..' + sep) || realRel === '..' || isAbsolute(realRel)) {
      throw new WorkspacePathError('Path escapes workspace')
    }
    return target
  }

  /**
   * 从授权工作区读取一个 UTF-8 文本文件（移植 read_file，workspace.py:115-123）。
   * 非文件→FileNotFoundError("File not found: <relative_path>")；超 maxTextFileBytes→RuntimeError("File is too large")。
   */
  readFile(relativePath: string): string {
    const target = this.resolvePath(relativePath)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(target)
    } catch {
      throw new Error(`File not found: ${relativePath}`)
    }
    if (!stats.isFile()) {
      throw new Error(`File not found: ${relativePath}`)
    }
    if (stats.size > this.maxTextFileBytes) {
      throw new Error('File is too large')
    }
    return readFileSync(target, 'utf8')
  }

  /**
   * 用整文件覆盖语义写入 UTF-8 文本（移植 write_file，workspace.py:125-132）。
   * 先按 UTF-8 字节检查大小（超限→RuntimeError("File is too large")），再 resolve 路径、建父目录、写入。
   * 关键：字节长度用 Buffer.byteLength（不是 content.length），与 Python len(content.encode()) 一致。
   */
  writeFile(relativePath: string, content: string): void {
    if (Buffer.byteLength(content, 'utf8') > this.maxTextFileBytes) {
      throw new Error('File is too large')
    }
    const target = this.resolvePath(relativePath)
    const parent = target.slice(0, target.length - (target.split(sep).pop()?.length ?? 0))
    mkdirSync(parent, { recursive: true })
    writeFileSync(target, content, 'utf8')
  }

  /**
   * 列举可见工作区文件并剪枝被阻断子树（移植 list_files，workspace.py:134-152）。
   * 自实现 walk：每层 dir 名 sorted 后剪掉黑名单目录避免下钻；file 名 sorted；跳过被阻断文件名/路径；
   * 返回 POSIX 相对路径；limit 截断。确定性：目录与文件名均排序。
   * @param limit 可选上限；达到即提前返回。
   */
  listFiles(limit?: number): string[] {
    const files: string[] = []
    // 自实现深度优先遍历，逐字对齐 Python os.walk + 原地 sorted/剪枝。
    const walk = (directory: string): boolean => {
      let entries: Dirent<string>[]
      try {
        entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        return true
      }
      // 分离 dir 与 file，各自排序（对应 sorted(dirnames) / sorted(filenames)）。
      const dirnames = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !BLOCKED_PATH_PARTS.has(name))
        .sort()
      const filenames = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
      for (const filename of filenames) {
        if (isBlockedWorkspaceFilename(filename)) {
          continue
        }
        const full = join(directory, filename)
        const rel = relative(this.root, full).split(sep).join('/')
        if (isBlockedWorkspacePath(pathParts(rel))) {
          continue
        }
        files.push(rel)
        if (limit !== undefined && files.length >= limit) {
          return false
        }
      }
      // os.walk 默认自顶向下：先产出本层文件，再按排序顺序下钻子目录。
      for (const dirname of dirnames) {
        if (!walk(join(directory, dirname))) {
          return false
        }
      }
      return true
    }
    walk(this.root)
    return files
  }
}

/** 判断一个命令是否需要人工审批（移植 is_dangerous_command，workspace.py:171-174）。任一正则命中即真。 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command)) || commandPolicy(command)
}

/** 判断命令是否需要 Kodeks 不执行的 shell 特性（移植 has_shell_only_syntax，workspace.py:269-272）。 */
export function hasShellOnlySyntax(command: string): boolean {
  return SHELL_ONLY_SYNTAX.test(command)
}

/** 为需要 shell 解析的命令返回非审批失败结果（移植 unsupported_shell_syntax_result，workspace.py:275-278）。 */
export function unsupportedShellSyntaxResult(command: string): ShellResult {
  return new ShellResult(command, null, '', SHELL_ONLY_ERROR, false, false, false)
}

/**
 * 无 shell 地解析 shell-like argv（移植 parse_command_args，workspace.py:240-266）。
 * 自实现：支持 '/" 引号（引号内逐字累加，遇同种引号闭合）；空白分隔；未闭合引号→null；空 argv→null。
 * 关键：非 shlex —— 不处理转义、$ 展开、反引号等，与 Python 自实现逐字一致。
 * @returns 解析出的 argv；未闭合引号或空命令返回 null。
 */
export function parseCommandArgs(command: string): string[] | null {
  const args: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    // Python str.isspace()：对常见空白字符（空格/制表/换行等）判真。
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote !== null) {
    return null
  }
  if (current) {
    args.push(current)
  }
  return args.length > 0 ? args : null
}

/**
 * 对无 shell argv 做一层命令策略判断：不替代 workspace 文件沙箱，只把高风险 argv 升级为审批。
 */
function commandPolicy(command: string): boolean {
  const args = parseCommandArgs(command)
  if (args === null) {
    return false
  }
  const executable = basename(args[0]).toLowerCase()
  if (APPROVAL_EXECUTABLES.has(executable)) {
    if (executable === 'node') {
      return args.slice(1).some((arg) => INLINE_CODE_FLAGS.has(arg))
    }
    return true
  }
  return args.slice(1).some((arg) => arg.startsWith('/') || arg.startsWith('~'))
}

/** 模块级默认执行后端（LocalExecutor）；测试可经 runApprovedCommand 的 executor 形参注入替身。 */
const defaultExecutor: Executor = new LocalExecutor()

/**
 * 解析安全命令并无 shell 执行，或请求审批（移植 run_command，workspace.py:177-199）。
 * 判定顺序严格保持（保真风险 6）：
 *  1) has_shell_only_syntax → unsupported_shell_syntax_result（approvalRequired=false，不审批）。
 *  2) is_dangerous_command → approvalRequired=true 的占位结果（exitCode=null，stderr="Command requires approval"）。
 *  3) 否则交给 runApprovedCommand 实跑。
 * @param command 模型给出的命令字符串。
 * @param cwd 执行目录（通常为 workspace root）。
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 10_000,
  maxOutputBytes = 65_536,
  executor: Executor = defaultExecutor,
): Promise<ShellResult> {
  if (hasShellOnlySyntax(command)) {
    return unsupportedShellSyntaxResult(command)
  }
  if (isDangerousCommand(command)) {
    return new ShellResult(
      command,
      null,
      '',
      'Command requires approval',
      true,
      false,
      false,
    )
  }
  return runApprovedCommand(
    command,
    cwd,
    timeoutMs,
    maxOutputBytes,
    'Command requires approval',
    executor,
  )
}

/**
 * 上层已批准后执行命令（移植 run_approved_command，workspace.py:202-237）。
 * 顺序：1) 再次 shell-only 短路；2) parseCommandArgs 失败（未闭合引号）→ approvalRequired=true 的占位结果；
 * 3) 经 executor 跑 argv；超时→ShellCommandTimeoutError；stdout/stderr 已在 executor 内按字节截断。
 * @param parseFailureMessage 解析失败时写入 stderr 的文案（默认 "Approved command could not be parsed"）。
 */
export async function runApprovedCommand(
  command: string,
  cwd: string,
  timeoutMs = 10_000,
  maxOutputBytes = 65_536,
  parseFailureMessage = 'Approved command could not be parsed',
  executor: Executor = defaultExecutor,
): Promise<ShellResult> {
  if (hasShellOnlySyntax(command)) {
    return unsupportedShellSyntaxResult(command)
  }
  const args = parseCommandArgs(command)
  if (args === null) {
    // parse 失败也请求审批（approvalRequired=true），与 Python 一致。
    return new ShellResult(command, null, '', parseFailureMessage, true, false, false)
  }
  let result
  try {
    result = await executor.run(args, { cwd, timeoutMs, maxOutputBytes })
  } catch (error) {
    if (error instanceof ExecutorTimeoutError) {
      throw new ShellCommandTimeoutError(`Shell command timed out: ${command}`)
    }
    throw error
  }
  return new ShellResult(
    command,
    result.exitCode,
    result.stdout,
    result.stderr,
    false,
    result.stdoutTruncated,
    result.stderrTruncated,
  )
}
