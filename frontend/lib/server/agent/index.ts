// frontend/lib/server/agent/index.ts
// Agent 循环（M4）公共 API 出口：顶层入口 + 注入工厂类型 + 子模块导出。
// 复用 M1（桥）/M2（存储）/M3（工具）；忠实移植 Python turn 编排 + 工具循环 + 审批 + context 装配。

// 顶层入口与常量
export { MAX_TOOL_LOOP_TURNS, runPythonChatTurn } from './runtime'

// 注入工厂 / 流类型（假模型注入点）
export {
  liveResponsesEvents,
  runResponsesToolLoop,
  type CompletionEventFactory,
  type ResponsesEventFactory,
  type ResponsesEventStream,
  type RunResponsesToolLoopArgs,
} from './responses-runtime'

// 工具循环原语
export {
  appendToolContinuationMessages,
  artifactThresholdBytes,
  handleOutputItem,
  mapToolStatus,
  parseJsonObject,
  parseToolArguments,
  ToolRoundState,
  type RuntimeEvent,
  type RuntimeToolStatus,
  type ToolCallRecord,
  type ToolMessageRecord,
  type ToolRegistryLike,
} from './tool-loop'

// context 装配
export {
  bodyWithRuntimeContext,
  buildMemoryContext,
  buildRuntimeInstructions,
  memoryContextIds,
  memoryContextLayerCounts,
  selectedFilesFromBody,
  type MemoryContext,
  type SelectedFile,
} from './context'

// transcript replay
export {
  buildResponsesInputFromMessages,
  buildResponsesInputFromTranscript,
  type ResponsesInputItem,
} from './conversation-state'

// harness 模式选择
export {
  HarnessDecision,
  selectHarnessPattern,
  type HarnessDecisionPayload,
  type HarnessPattern,
} from './harness'
