// frontend/lib/server/execution/sandbox-executor.ts
// Vercel Sandbox 命令执行后端（M6 云端）：实现与 LocalExecutor 完全相同的 Executor 接口，
// 在 Firecracker microVM 里以 argv 无 shell 执行命令，透明替换本地 child_process 后端。
// 返回形状（exitCode / stdout / stderr / *Truncated）与 LocalExecutor 逐字一致，runApprovedCommand 可无感切换。
//
// 红线（见 M6 任务书、50-tools-security.md §2.4）：
//  · argv 无 shell：runCommand({cmd: args[0], args: args.slice(1)})，绝不拼 shell 字符串。
//  · 超时按 timeoutMs：超时抛 ExecutorTimeoutError（与 LocalExecutor 一致，供上层转 ShellCommandTimeoutError）。
//  · stdout/stderr 各按 UTF-8 字节截到 maxOutputBytes，复用 executor.ts 的 truncateByBytes。
// @vercel/sandbox v2.1.1：Sandbox.create({timeout?}) → Sandbox；sandbox.runCommand({cmd,args,cwd,timeoutMs}) → CommandFinished
//   （exitCode:number、await .stdout()、await .stderr()）；sandbox.stop() 销毁。
//   鉴权：SDK 自动读 VERCEL_OIDC_TOKEN（线上自动）或 VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID（access token）。
import { Sandbox } from '@vercel/sandbox'
import {
  type Executor,
  type ExecutorRunOptions,
  type ExecutorRunResult,
  ExecutorTimeoutError,
  truncateByBytes,
} from './executor'

/**
 * 给一个 Promise 套上超时竞速（纯逻辑，便于单测）。
 * 在 timeoutMs 内 work 完成则透传其结果；否则 reject 一个由 onTimeout() 产出的错误。
 * 与 LocalExecutor 的 execFile timeout 语义对齐：超时即 reject ExecutorTimeoutError。
 * @param work 实际工作 Promise（此处为 runCommand）。
 * @param timeoutMs 超时毫秒。
 * @param onTimeout 超时时构造要 reject 的错误（注入以便测试，不直接 new）。
 * @returns work 的结果；超时则 reject。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // 超时支：到点 reject；用单独 Promise 与 work 竞速。
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    // 无论先到的是 work 还是超时，都清掉定时器，避免悬挂句柄。
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Vercel Sandbox 执行后端（M6 生产）：每次 run 起一个短生命周期 sandbox 跑一条 argv 再销毁。
 * 仅在运行于 Vercel 且配置了 sandbox 鉴权时由 deps.ts 选用；本地默认仍是 LocalExecutor。
 */
export class SandboxExecutor implements Executor {
  private readonly runtime: string

  /**
   * @param runtime sandbox 运行时镜像（默认 node24，与 SDK 默认一致）；命令执行环境由它决定。
   */
  constructor(runtime = 'node24') {
    this.runtime = runtime
  }

  /**
   * 在一个一次性 Vercel Sandbox 里无 shell 执行 argv，返回截断后的退出码与输出。
   * 形状与 LocalExecutor.run 完全一致：超时 → ExecutorTimeoutError；stdout/stderr 各按字节截断。
   * @param args 解析后的 argv，args[0] 为可执行文件，其余为参数（绝不经 shell）。
   * @param options cwd / timeoutMs / maxOutputBytes。
   */
  async run(args: string[], options: ExecutorRunOptions): Promise<ExecutorRunResult> {
    const [file, ...rest] = args
    // sandbox 自身超时给一点冗余，确保命令级 timeoutMs 先生效（命令杀在前，VM 收尾在后）。
    const sandbox = await Sandbox.create({
      runtime: this.runtime,
      timeout: options.timeoutMs + 60_000,
    })
    try {
      // runCommand 的 timeoutMs 由 sandbox 在 exec 时强制（到点 SIGKILL）；
      // 但 SIGKILL 不会 reject，故再用 withTimeout 竞速，超时统一抛 ExecutorTimeoutError（与 Local 对齐）。
      const finished = await withTimeout(
        sandbox.runCommand({
          cmd: file,
          args: rest,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
        }),
        options.timeoutMs,
        () => new ExecutorTimeoutError('Sandbox command timed out'),
      )
      // CommandFinished.stdout()/stderr() 收集全量输出字符串；再按字节预算截断（复用同一截断逻辑）。
      const stdoutText = await finished.stdout()
      const stderrText = await finished.stderr()
      const [stdout, stdoutTruncated] = truncateByBytes(stdoutText, options.maxOutputBytes)
      const [stderr, stderrTruncated] = truncateByBytes(stderrText, options.maxOutputBytes)
      return {
        exitCode: finished.exitCode,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      }
    } finally {
      // 一次性 sandbox：无论成功/失败/超时都销毁，避免泄漏 microVM。stop 失败不应掩盖原始错误。
      try {
        await sandbox.stop()
      } catch {
        // 销毁失败仅忽略（VM 会随会话超时自动回收）；不向上抛以免遮蔽命令结果/超时错误。
      }
    }
  }
}
