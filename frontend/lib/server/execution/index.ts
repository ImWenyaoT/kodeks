// frontend/lib/server/execution/index.ts
// 执行层公共 API 出口：Executor 契约 + 本地/沙箱两种后端 + 纯工具。
// deps.ts 的 resolveExecutor 从这里取后端；workspace.ts 仍直接 import './execution/executor'。

// 契约、错误、截断工具、本地后端
export {
  type Executor,
  type ExecutorRunOptions,
  type ExecutorRunResult,
  ExecutorUnavailableError,
  ExecutorTimeoutError,
  LocalExecutor,
  truncateByBytes,
} from './executor'

// Vercel Sandbox 云后端（M6）+ 其纯逻辑超时竞速工具
export { SandboxExecutor, withTimeout } from './sandbox-executor'
