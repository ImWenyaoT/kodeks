// frontend/lib/server/storage/types.ts
// 存储层契约：用 Zod 镜像 Python src/kodeks/contracts.py 的 Stored* 模型与枚举。
// 输出形状一律 camelCase（对应 Python 的 model_dump(by_alias=True)，见 40-storage.md §9）。
// plan 相关复用 wire/events.ts 已建的 storedPlanArtifactSchema/storedPlanStepSchema。
//
// 保真红线（见 40-storage.md §7/§8/§9、保真风险 13）：
//  · AuditEventType 13 值、SessionMode 2 值、approval status 4 值、plan status 2 值逐字。
//  · camelCase 字段名即 wire 形状；不引入 snake_case 输出。
import { z } from 'zod'
import { storedPlanArtifactSchema, storedPlanStepSchema } from '../wire/events'

// ── 枚举（逐字移植 contracts.py:11-26）──────────────────────────────────────

/** 会话模式（contracts.py:11 SessionMode = Literal["act", "plan"]）。 */
export const sessionModeSchema = z.enum(['act', 'plan'])
export type SessionMode = z.infer<typeof sessionModeSchema>

/** 审计事件 type（13 值，顺序逐字移植 contracts.py:12-26）。 */
export const auditEventTypeSchema = z.enum([
  'turn_started',
  'harness_pattern_selected',
  'memory_recalled',
  'tool_called',
  'tool_failed',
  'tool_result',
  'approval_required',
  'approval_rejected',
  'approval_executed',
  'plan_checkpointed',
  'subagent_started',
  'subagent_completed',
  'turn_completed',
])
export type AuditEventType = z.infer<typeof auditEventTypeSchema>

/** 全部审计事件 type 元组（移植 contracts.py:28-42 AUDIT_EVENT_TYPES）。 */
export const AUDIT_EVENT_TYPES = auditEventTypeSchema.options

/** approval 状态机 4 值（移植 contracts.py:122）。 */
export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'executed'])
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>

/** plan 工件状态 2 值（移植 contracts.py:85）。 */
export const planStatusSchema = z.enum(['active', 'archived'])
export type PlanStatus = z.infer<typeof planStatusSchema>

/** plan step 状态 3 值（移植 contracts.py:73）。 */
export const planStepStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>

// ── plan 契约（复用 wire/events.ts）─────────────────────────────────────────

/** 内嵌 plan step（复用 wire/events.ts storedPlanStepSchema，contracts.py:68-74）。 */
export const storedPlanStep = storedPlanStepSchema
export type StoredPlanStep = z.infer<typeof storedPlanStep>

/** active plan 工件（复用 wire/events.ts storedPlanArtifactSchema，contracts.py:77-88）。 */
export const storedPlanArtifact = storedPlanArtifactSchema
export type StoredPlanArtifact = z.infer<typeof storedPlanArtifact>

// ── Stored* 契约（camelCase，移植 contracts.py）─────────────────────────────

/** 会话元数据（移植 StoredSession，contracts.py:91-101）。 */
export const storedSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  mode: sessionModeSchema,
  workspaceRoot: z.string(),
  parentSessionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
})
export type StoredSession = z.infer<typeof storedSessionSchema>

/** transcript 消息（移植 StoredMessage，contracts.py:104-112）。content/agentEvent 为任意 JSON。 */
export const storedMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.string(),
  content: z.unknown(),
  agentEvent: z.unknown().nullable(),
  createdAt: z.string(),
})
export type StoredMessage = z.infer<typeof storedMessageSchema>

/** 危险命令审批记录（移植 StoredApproval，contracts.py:115-125）。 */
export const storedApprovalSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  toolCallId: z.string().nullable(),
  command: z.unknown(),
  status: approvalStatusSchema,
  reason: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
})
export type StoredApproval = z.infer<typeof storedApprovalSchema>

// ── 手工 camelCase dict 形状（memory/subagent 不走 Pydantic，见 40-storage.md §9）──

/** recall 返回的简单 memory 行（memory.py:68-76）。 */
export type RecalledMemory = {
  id: string
  scope: string
  content: string
  sourceSessionId: string | null
  confidence: number
  createdAt: string
  updatedAt: string
}

/** _recall_layer 返回的 atom 行（含 freshness，memory.py:247-256）。 */
export type RecalledAtom = {
  id: string
  scope: string
  content: string
  sourceSessionId: string | null
  confidence: number
  freshness: number
  createdAt: string
  updatedAt: string
}

/** _recall_artifacts 返回的 artifact 行（不含 sessionId/toolCallId，memory.py:273-282）。 */
export type RecalledArtifact = {
  id: string
  refId: string
  toolName: string
  summary: string
  filePath: string
  byteLength: number
  contentHash: string
  createdAt: string
}

/** recall_layered 返回结构（memory.py:85-92）。 */
export type LayeredRecall = {
  atoms: RecalledAtom[]
  artifacts: RecalledArtifact[]
}

/** remember_artifact 返回的元数据 dict（memory.py:198-209）。 */
export type StoredArtifact = {
  id: string
  refId: string
  sessionId: string | null
  toolCallId: string | null
  toolName: string
  summary: string
  filePath: string
  byteLength: number
  contentHash: string
  createdAt: string
}

/** read_artifact_content 返回结构（memory.py:106-120）。 */
export type ArtifactContent = {
  artifact: StoredArtifact
  content: string
}

/** subagent run 记录（start_run/get_run/complete_run，memory.py:298-307）。 */
export type SubagentRun = {
  id: string
  parentSessionId: string
  agentName: string
  task: string
  summary: string | null
  status: string
  createdAt: string
  completedAt: string | null
}
