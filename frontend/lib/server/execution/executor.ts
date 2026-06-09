// frontend/lib/server/execution/executor.ts
// 命令执行后端抽象：把"如何运行 argv"从 workspace 策略层解耦。
// LocalExecutor 用 Node child_process.execFile 直跑（绝不 shell:true），
// 逐字节移植 Python src/kodeks/workspace.py 的 subprocess.run 语义（10s 超时、64KB 字节截断、errors="ignore"）。
// Vercel Sandbox 后端是 M6 —— 此处只为它留好 Executor 接口，不在本批实现。
//
// 保真红线（见 50-tools-security.md §2.4、保真风险 3）：
//  · 绝不经 shell（execFile 不拼 shell 字符串），逐字对齐 Python subprocess.run(args, ...) 不带 shell=True。
//  · stdout/stderr 各按 UTF-8 字节截到 max（默认 65536），截断用 TextDecoder fatal:false（等价 errors="ignore"）。
//  · 超时由调用方（runApprovedCommand）转成 ShellCommandTimeoutError，本层只透出超时信号。
import { execFile } from 'node:child_process'

/** 单条命令的执行结果（已按字节截断）。 */
export interface ExecutorRunResult {
  /** 进程退出码；非正常退出（如被信号杀死）时可能为 null。 */
  exitCode: number | null
  /** 截断后的 stdout 文本。 */
  stdout: string
  /** 截断后的 stderr 文本。 */
  stderr: string
  /** stdout 是否因超出字节预算被截断。 */
  stdoutTruncated: boolean
  /** stderr 是否因超出字节预算被截断。 */
  stderrTruncated: boolean
}

/** Executor.run 的可选项（cwd / 超时毫秒 / 单流最大字节）。 */
export interface ExecutorRunOptions {
  /** 工作目录（命令的 cwd）。 */
  cwd: string
  /** 超时毫秒（超时则 reject 一个 timeout 标记错误）。 */
  timeoutMs: number
  /** stdout/stderr 各自的最大 UTF-8 字节数（超出则截断并置 *Truncated）。 */
  maxOutputBytes: number
}

/**
 * 命令执行后端接口。M6 的 Vercel Sandbox 后端实现同一接口即可替换。
 * 约定：run 内部不经任何 shell；args 已是解析好的 argv（argv[0] 为可执行文件）。
 */
export interface Executor {
  /** 运行一条 argv，返回截断后的退出码与输出；超时须 reject 一个标记了 isTimeout 的错误。 */
  run(args: string[], options: ExecutorRunOptions): Promise<ExecutorRunResult>
}

/** 超时信号错误：LocalExecutor 在进程超时时 reject 此错误，供上层转 ShellCommandTimeoutError。 */
export class ExecutorTimeoutError extends Error {
  /** 标记位：上层据此识别超时（而非把任意错误都当超时）。 */
  readonly isTimeout = true

  constructor(message: string) {
    super(message)
    this.name = 'ExecutorTimeoutError'
  }
}

/**
 * 把文本按 UTF-8 字节预算截断（移植 Python _truncate，workspace.py:281-287）。
 * 字节数 <= max 时原样返回；超出则取前 max 字节后用 TextDecoder（fatal:false）解码，
 * 等价 Python `encoded[:max].decode(errors="ignore")`（丢弃尾部不完整的多字节序列）。
 * @returns [截断后文本, 是否被截断]
 */
export function truncateByBytes(value: string, maxBytes: number): [string, boolean] {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length <= maxBytes) {
    return [value, false]
  }
  // TextDecoder 默认 fatal:false 会用替换符处理不完整序列；为对齐 errors="ignore"，
  // 用 ignoreBOM:false + 手动剥除截断点产生的替换符。Node 的 TextDecoder 在末尾不完整
  // 多字节序列处会产出 U+FFFD；errors="ignore" 则直接丢弃。因此解码后去掉尾部替换符。
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, maxBytes))
  return [decoded.replace(/�+$/u, ''), true]
}

/**
 * 本地执行后端（M3 默认）：Node child_process.execFile 直跑 argv，绝不经 shell。
 * 逐字节对齐 Python workspace.run_approved_command 的 subprocess.run 语义：
 *  · 不抛非零退出（execFile 的 error.code 即 returncode，仍返回结果）。
 *  · 超时（默认 10000ms）→ reject ExecutorTimeoutError。
 *  · stdout/stderr 各按 maxOutputBytes（默认 65536）字节截断。
 */
export class LocalExecutor implements Executor {
  /**
   * 运行一条 argv。
   * @param args 解析后的 argv，args[0] 为可执行文件名，其余为参数。
   * @param options cwd / timeoutMs / maxOutputBytes。
   */
  run(args: string[], options: ExecutorRunOptions): Promise<ExecutorRunResult> {
    const [file, ...rest] = args
    return new Promise<ExecutorRunResult>((resolve, reject) => {
      execFile(
        file,
        rest,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          // 以 Buffer 收集，便于按字节精确截断（不被 string 编码层污染）。
          encoding: 'buffer',
          // 给一个宽松的 maxBuffer，截断由我们按字节预算自行处理（Node 默认 1MB 可能误杀）。
          maxBuffer: 64 * 1024 * 1024,
          // 绝不经 shell。
          shell: false,
        },
        (error, stdoutBuf, stderrBuf) => {
          // 超时：execFile 用 SIGTERM 杀进程并把 error.killed=true、error.signal 置位。
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean })?.killed
          if (error && killed) {
            reject(new ExecutorTimeoutError('Executor process timed out'))
            return
          }
          const stdoutText = (stdoutBuf as Buffer).toString('utf8')
          const stderrText = (stderrBuf as Buffer).toString('utf8')
          const [stdout, stdoutTruncated] = truncateByBytes(stdoutText, options.maxOutputBytes)
          const [stderr, stderrTruncated] = truncateByBytes(stderrText, options.maxOutputBytes)
          // 退出码：正常完成 error===null → 0；非零退出 error.code 为数字；信号终止则为 null。
          let exitCode: number | null = 0
          if (error) {
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
            exitCode = typeof code === 'number' ? code : null
          }
          resolve({ exitCode, stdout, stderr, stdoutTruncated, stderrTruncated })
        },
      )
    })
  }
}
