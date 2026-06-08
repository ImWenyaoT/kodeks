// frontend/lib/server/oracle.ts
// 加载仓库根 oracle/ 下由 Python 录制的黄金 transcript fixtures，供 TS 端逐事件/逐字节对拍。
// 路径基于本模块位置解析（不依赖 cwd），因此在 vitest 与运行时下都稳定。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根的 oracle 目录（frontend/lib/server → 上溯三级到仓库根）。 */
export const ORACLE_DIR = resolve(HERE, '../../../oracle')

/** manifest.json 中单个场景的摘要。 */
export interface OracleScenarioSummary {
  id: string
  rounds: number
  runtimeEvents: number
  uiFrames: number
  eventTypes: string[]
}

/** oracle/manifest.json 的形状。 */
export interface OracleManifest {
  schemaVersion: number
  recordedAt: string
  pythonCommit: string
  volatileFieldPaths: string[]
  scenarios: OracleScenarioSummary[]
}

/** 读取 oracle 清单。 */
export function loadManifest(): OracleManifest {
  return JSON.parse(readFileSync(resolve(ORACLE_DIR, 'manifest.json'), 'utf8')) as OracleManifest
}

/** 声明式记忆 seed（setup.json.seedMemories 的单项，供 TS 重放复现召回条件）。 */
export interface OracleSeedMemory {
  scope: string
  content: string
  sourceSessionId?: string | null
}

/** 跨语言重放复现条件（setup.json：workspace 文件 / env / 记忆 seed）。 */
export interface OracleSetup {
  workspaceFiles: Record<string, string>
  env: Record<string, string | null>
  seedMemories: OracleSeedMemory[]
}

/** 单个场景的全部黄金数据。 */
export interface OracleScenario {
  id: string
  request: Record<string, unknown>
  setup: OracleSetup
  script: Record<string, unknown>[][]
  runtimeEvents: Record<string, unknown>[]
  runtimeSse: string
  uiSse: string
  audit: { event_type: string; payload: unknown }[]
}

/** 读取单个场景的黄金数据（含 setup.json 重放复现条件）。 */
export function loadScenario(id: string): OracleScenario {
  const dir = resolve(ORACLE_DIR, 'scenarios', id)
  const json = <T>(file: string): T => JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as T
  return {
    id,
    request: json('request.json'),
    setup: json('setup.json'),
    script: json('script.json'),
    runtimeEvents: json('runtime-events.json'),
    runtimeSse: readFileSync(resolve(dir, 'runtime.sse'), 'utf8'),
    uiSse: readFileSync(resolve(dir, 'ui.sse'), 'utf8'),
    audit: json('audit.json'),
  }
}

/** 读取全部场景（按 manifest 顺序）。 */
export function loadAllScenarios(): OracleScenario[] {
  return loadManifest().scenarios.map((summary) => loadScenario(summary.id))
}
