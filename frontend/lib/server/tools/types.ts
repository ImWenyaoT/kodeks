// frontend/lib/server/tools/types.ts
// 工具注册表共享契约：移植 Python src/kodeks/tools/types.py。
// ToolExecutionContext / ToolExecutionResult / RegisteredTool / ToolRegistryServices。
//
// 保真红线（见 50-tools-security.md §1、保真风险 1）：
//  · ToolExecutionResult.status 是三态：'completed' | 'failed' | 'approval_required'（approval 是第三种工具状态）。
//  · handler 在 TS 侧为异步（M2 存储是异步 libSQL 驱动），Python 同步语义经 Promise 透出。
import type { KodeksDatabase } from '../storage'
import type { WorkspaceService } from '../workspace'

/** 模型给出的工具参数（任意 JSON 形状）。 */
export type ToolArguments = Record<string, unknown>

/** 工具执行三态（移植 ToolExecutionStatus，types.py:14）。 */
export type ToolExecutionStatus = 'completed' | 'failed' | 'approval_required'

/**
 * 把 session/tool-call id 带入审批与审计记录（移植 ToolExecutionContext，types.py:17-22）。
 * 两字段均可空，缺省 undefined（对应 Python None）。
 */
export interface ToolExecutionContext {
  sessionId?: string | null
  toolCallId?: string | null
}

/** 模型可见的工具执行结果（移植 ToolExecutionResult，types.py:25-30）。output 为紧凑 JSON 字符串。 */
export interface ToolExecutionResult {
  status: ToolExecutionStatus
  output: string
}

/**
 * 确定性本地工具 handler 所用的服务包（移植 ToolRegistryServices，types.py:33-39）。
 * environment 缺省时由 helpers.runtimeEnvironment 回退到 process.env。
 */
export interface ToolRegistryServices {
  workspace: WorkspaceService
  database: KodeksDatabase
  environment?: Record<string, string | null | undefined>
}

/** 工具 JSON schema 形状（移植 ToolDefinition，schemas.py:18-23）。 */
export interface ToolParameterSchema {
  type?: string
  properties?: Record<string, ToolParameterSchema>
  required?: string[]
  items?: ToolParameterSchema
  enum?: string[]
}

/** provider-facing 工具定义（移植 ToolDefinition，schemas.py:18-23）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameterSchema
}

/**
 * 一个已注册工具的定义与其 handler（移植 RegisteredTool，types.py:42-49）。
 * handler 异步返回 ToolExecutionResult（M2 存储异步）。read_only/mutating 仅用于 plan 过滤口径。
 */
export interface RegisteredTool {
  definition: ToolDefinition
  readOnly: boolean
  mutating: boolean
  handler: (
    args: ToolArguments,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>
}
