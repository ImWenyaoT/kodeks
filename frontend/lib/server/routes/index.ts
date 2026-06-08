// frontend/lib/server/routes/index.ts
// 路由层公共 API 出口：可注入的纯逻辑函数 + 生产依赖。
// app/api/**/route.ts 是薄包装，从这里取逻辑并接生产依赖（deps.ts）。

// 生产依赖
export {
  getDatabase,
  readJsonBody,
  resolveArtifactStore,
  resolveExecutor,
  resolveWorkspaceRoot,
  shouldUseSandboxExecutor,
} from './deps'

// chat SSE
export {
  createChatStreamResponse,
  createChatUiResponse,
  type ChatStreamArgs,
} from './chat'

// sessions
export { listSessions, createSession, getSession } from './sessions'

// approvals
export { getApproval, decideApproval } from './approvals'

// workspace
export { filesList } from './workspace'

// models
export { modelsCatalog } from './models'

// preflight
export {
  bridgePreflight,
  defaultUpstreamCheck,
  type BridgePreflightArgs,
  type UpstreamCheck,
} from './preflight'

// health
export { health } from './health'
