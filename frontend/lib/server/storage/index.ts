// frontend/lib/server/storage/index.ts
// 存储层公共 API 出口（对应 Python src/kodeks/storage/__init__.py）。
// 汇总门面、工厂、repository、错误类、契约、schema、工具与 artifact 后端。

// 门面与工厂
export {
  KodeksDatabase,
  createDatabase,
  type CreateDatabaseOptions,
} from './database'

// schema
export {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_SQL,
  SCHEMA_TABLE_NAMES,
  type SchemaTableName,
} from './schema'

// repository 与错误类
export {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  ApprovalRepository,
  AuditLogRepository,
  PlanRepository,
  SessionRepository,
  type HasConnection,
} from './repositories/session'
export {
  MemoryRepository,
  SubagentRepository,
  summarizeArtifactOutput,
  type HasMemoryDependencies,
} from './repositories/memory'

// artifact 落盘后端
export {
  type ArtifactStore,
  LocalFileArtifactStore,
} from './artifact-store'

// 工具
export {
  currentTimestamp,
  prefixedId,
  sha256Hex,
  utf8ByteLength,
  mapApproval,
  mapMessage,
  mapPlan,
  mapSession,
} from './utils'

// 契约与枚举
export {
  AUDIT_EVENT_TYPES,
  approvalStatusSchema,
  auditEventTypeSchema,
  planStatusSchema,
  planStepStatusSchema,
  sessionModeSchema,
  storedApprovalSchema,
  storedMessageSchema,
  storedPlanArtifact,
  storedPlanStep,
  storedSessionSchema,
  type ApprovalStatus,
  type ArtifactContent,
  type AuditEventType,
  type LayeredRecall,
  type PlanStatus,
  type PlanStepStatus,
  type RecalledArtifact,
  type RecalledAtom,
  type RecalledMemory,
  type SessionMode,
  type StoredApproval,
  type StoredArtifact,
  type StoredMessage,
  type StoredPlanArtifact,
  type StoredPlanStep,
  type StoredSession,
  type SubagentRun,
} from './types'
