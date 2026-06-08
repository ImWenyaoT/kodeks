// frontend/lib/server/agent/harness.test.ts
// 移植自 Python tests/test_runtime_harness.py：harness 模式注入+审计、有界模式选择映射。
// 用 :memory: libSQL（异步 createDatabase）+ 临时 workspace + 注入工厂。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type KodeksDatabase } from '../storage'
import { runPythonChatTurn } from './runtime'
import { selectHarnessPattern } from './harness'
import type { ResponsesEventFactory } from './responses-runtime'

/** 创建一个临时工作区目录。 */
function makeWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), 'kodeks-harness-'))
}

describe('Harness 模式选择与运行时注入（移植 tests/test_runtime_harness.py）', () => {
  let db: KodeksDatabase

  beforeEach(async () => {
    db = await createDatabase(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('运行时 context 记录为何选定有界 harness 模式并写审计（test_..._injects_harness_pattern_and_audit）', async () => {
    const root = makeWorkspaceDir()
    const seenBodies: Record<string, unknown>[] = []
    const factory: ResponsesEventFactory = (body) => {
      seenBodies.push(body)
      return [{ type: 'response.completed', response: { id: 'resp_harness' } }]
    }

    for await (const _event of runPythonChatTurn(
      {
        input: 'Verify every technical claim against the codebase.',
        session_id: 'sess_harness',
        mode: 'plan',
      },
      db,
      root,
      {},
      factory,
    )) {
      void _event
    }

    const result = await db.connection.execute(
      "SELECT payload_json FROM audit_log WHERE event_type = 'harness_pattern_selected'",
    )
    const payload = JSON.parse(String(result.rows[0].payload_json)) as {
      pattern: string
      failureModes: string[]
    }

    expect(payload.pattern).toBe('adversarial_verify')
    expect(payload.failureModes).toContain('self_preferential_bias')
    expect(String(seenBodies[0].instructions)).toContain(
      'Harness pattern for this turn: adversarial_verify.',
    )
    expect(String(seenBodies[0].instructions)).toContain(
      'claim, evidence, risk, confidence, and nextAction',
    )
  })

  it('harness 模式选择把复杂请求映射到固定小集合（test_harness_pattern_selection_keeps_workflows_bounded）', () => {
    const loop = selectHarnessPattern(
      "This test fails maybe 1 in 50 runs; don't stop until one theory works.",
      'act',
    )
    const verify = selectHarnessPattern('Verify every technical claim against the codebase.', 'plan')
    const tournament = selectHarnessPattern(
      'I need a name for this CLI tool; run a tournament for the top 3.',
      'plan',
    )
    const fanout = selectHarnessPattern(
      'Use a workflow to rename our User model to Account everywhere.',
      'plan',
    )

    expect(loop.pattern).toBe('loop_until_done')
    expect(verify.pattern).toBe('adversarial_verify')
    expect(tournament.pattern).toBe('tournament')
    expect(fanout.pattern).toBe('fanout_synthesize')
    expect(loop.approvalBoundary).toContain('Subagents are read-only')
    expect(new Set(Object.keys(loop.subagentContract))).toEqual(
      new Set(['claim', 'evidence', 'risk', 'confidence', 'nextAction']),
    )
  })

  it('plan 模式与默认 act 均落 single_turn，理由不同（覆盖默认分支）', () => {
    const planDecision = selectHarnessPattern('write a hello world function', 'plan')
    const actDecision = selectHarnessPattern('write a hello world function', 'act')
    expect(planDecision.pattern).toBe('single_turn')
    expect(actDecision.pattern).toBe('single_turn')
    expect(planDecision.reasons[0]).toContain('plan mode keeps ordinary planning')
    expect(actDecision.reasons[0]).toContain('ordinary coding turn')
  })
})
