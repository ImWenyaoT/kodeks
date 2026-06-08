// frontend/lib/server/agent/oracle-replay.test.ts
// Oracle 10 场景重放（M4 最关键门禁）：用 Python 录制的脚本化假模型驱动 TS 的 runPythonChatTurn，
// 收集 runtime 事件，归一化 volatile（生成 id + ISO 时间戳）后与 runtime-events.json 逐事件深比较。
//
// 复现条件来自 setup.json：workspaceFiles 写入临时目录、env、seedMemories 经 db.memories.remember 预置。
// 注入工厂：第 i 次调用返回 script.json 的第 i 个轮次（与 Python 录制的 continuation 轮次一一对应）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type KodeksDatabase } from '../storage'
import { loadAllScenarios, type OracleScenario } from '../oracle'
import { runPythonChatTurn } from './runtime'
import type { ResponsesEventFactory } from './responses-runtime'

/** 把一个临时工作区目录建好并写入 setup.workspaceFiles。 */
function makeWorkspace(workspaceFiles: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kodeks-oracle-'))
  for (const [relPath, content] of Object.entries(workspaceFiles)) {
    const target = join(root, relPath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

/**
 * 归一化 volatile 字段：把生成 id（32 hex）与 ISO 时间戳替换为占位符。
 * 覆盖 tool_output 内嵌 id（事件 JSON.stringify 后整体正则替换，再 parse 回结构）。
 */
function normalizeEvents(events: unknown[]): unknown[] {
  const json = JSON.stringify(events)
    // 生成 id：appr/atom/plan/msg/mem/mart/sub/aud 前缀 + 32 位十六进制。
    .replace(/(appr|atom|plan|msg|mem|mart|sub|aud)_[0-9a-f]{32}/g, '<id>')
    // ISO 时间戳（createdAt/updatedAt 等）。
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
  return JSON.parse(json) as unknown[]
}

/**
 * 构建注入工厂：按调用次序返回 script.json 的对应轮次（第 i 次 → 第 i 个轮次）。
 * 与 Python 录制器的 capturing_factory 语义一致：每轮 continuation 取下一个脚本数组。
 */
function makeScriptedFactory(rounds: Record<string, unknown>[][]): ResponsesEventFactory {
  let index = 0
  return () => {
    const round = rounds[index] ?? rounds[rounds.length - 1] ?? []
    index += 1
    return round
  }
}

/** 跑一个场景并收集 runtime 事件。 */
async function replayScenario(
  scenario: OracleScenario,
  db: KodeksDatabase,
): Promise<unknown[]> {
  const root = makeWorkspace(scenario.setup.workspaceFiles)
  for (const memory of scenario.setup.seedMemories) {
    await db.memories.remember(
      String(memory.scope),
      String(memory.content),
      memory.sourceSessionId ?? null,
    )
  }
  const factory = makeScriptedFactory(scenario.script)
  const events: unknown[] = []
  for await (const event of runPythonChatTurn(
    scenario.request,
    db,
    root,
    scenario.setup.env,
    factory,
  )) {
    events.push(event)
  }
  return events
}

describe('Oracle 10 场景重放：TS runPythonChatTurn 逐事件对拍 Python 黄金 transcript', () => {
  const scenarios = loadAllScenarios()
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('清单包含 10 个场景', () => {
    expect(scenarios.length).toBe(10)
  })

  for (const scenario of scenarios) {
    it(`场景 ${scenario.id} 的 runtime 事件与黄金 transcript 归一化后逐事件一致`, async () => {
      const actual = await replayScenario(scenario, db)
      const normalizedActual = normalizeEvents(actual)
      const normalizedExpected = normalizeEvents(scenario.runtimeEvents)
      expect(normalizedActual).toEqual(normalizedExpected)
    })
  }
})
