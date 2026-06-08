// frontend/lib/server/agent/harness.ts
// 有界 harness 模式选择：逐字节忠实移植自 Python src/kodeks/harness.py。
// 5 种模式、中英关键词逐字、匹配顺序、toPayload camelCase 全部保真。
//
// 保真红线（见 30-runtime-loop.md、80-oracle §B）：
//  · 关键词表逐字（中英混排）；匹配用首尾各加一个空格的 ` ${lowered} ` 做子串包含。
//  · 匹配优先级固定：loop_until_done → adversarial_verify → tournament → fanout_synthesize → plan/默认 single_turn。
//  · toPayload 输出 camelCase：pattern/reasons/failureModes/stopCondition/approvalBoundary/subagentContract。

/** harness 模式 5 值（移植 HarnessPattern，harness.py:8-14）。 */
export type HarnessPattern =
  | 'single_turn'
  | 'fanout_synthesize'
  | 'adversarial_verify'
  | 'loop_until_done'
  | 'tournament'

/** harness 决策的审计/上下文 payload 形状（toPayload 输出，camelCase，harness.py:28-38）。 */
export interface HarnessDecisionPayload {
  pattern: HarnessPattern
  reasons: string[]
  failureModes: string[]
  stopCondition: string
  approvalBoundary: string
  subagentContract: Record<string, string>
}

/**
 * 一个 turn 选定的有界 harness 形状（移植 HarnessDecision dataclass，harness.py:17-38）。
 * 字段以 snake_case 保存（与 Python dataclass 一致），toPayload 时转 camelCase。
 */
export class HarnessDecision {
  /**
   * @param pattern 选定模式
   * @param reasons 选择理由（单元素列表）
   * @param failureModes 需防范的失效模式
   * @param stopCondition 停止条件
   * @param approvalBoundary 审批边界文案
   * @param subagentContract 子代理输出契约（CERCN）
   */
  constructor(
    readonly pattern: HarnessPattern,
    readonly reasons: string[],
    readonly failureModes: string[],
    readonly stopCondition: string,
    readonly approvalBoundary: string,
    readonly subagentContract: Record<string, string>,
  ) {}

  /** 返回审计日志与运行时上下文用的 JSON-safe payload（移植 to_payload，harness.py:28-38）。 */
  toPayload(): HarnessDecisionPayload {
    return {
      pattern: this.pattern,
      reasons: this.reasons,
      failureModes: this.failureModes,
      stopCondition: this.stopCondition,
      approvalBoundary: this.approvalBoundary,
      subagentContract: this.subagentContract,
    }
  }
}

/**
 * 为一个 chat turn 选择一个小的 harness 模式（移植 select_harness_pattern，harness.py:41-162）。
 * 不构造通用工作流引擎：按固定优先级用关键词匹配映射到 5 个固定模式之一。
 * @param userInput 用户输入文本
 * @param mode 当前会话模式（'act' | 'plan'）
 */
export function selectHarnessPattern(userInput: string, mode: string): HarnessDecision {
  const lowered = userInput.toLowerCase()
  const text = ` ${lowered} `
  if (
    containsAny(text, [
      'flaky',
      'intermittent',
      '1 in 50',
      "don't stop",
      'dont stop',
      'until',
      'loop',
      'rerun',
      '偶发',
      '复现',
      '不要停',
      '直到',
      '循环',
    ])
  ) {
    return decision(
      'loop_until_done',
      'task has an unknown amount of work or requires repeated evidence checks',
      ['agentic_laziness', 'goal_drift'],
      'stop only when the stated condition is met or the explicit budget is exhausted',
    )
  }
  if (
    containsAny(text, [
      'verify',
      'review',
      'security',
      'audit',
      'claim',
      'rubric',
      'double-check',
      'double check',
      'adversarial',
      'skeptic',
      '验证',
      '审查',
      '核对',
      '反驳',
      '质疑',
      '安全',
    ])
  ) {
    return decision(
      'adversarial_verify',
      'task quality depends on an explicit independent check',
      ['self_preferential_bias', 'goal_drift'],
      'stop after findings are checked against the rubric and unresolved risks are surfaced',
    )
  }
  if (
    containsAny(text, [
      'tournament',
      'rank',
      'top 3',
      'top three',
      'brainstorm',
      ' name ',
      'naming',
      'taste',
      'compare',
      '排序',
      '排名',
      '命名',
      '取名',
      '比较',
      '品味',
    ])
  ) {
    return decision(
      'tournament',
      'task benefits from comparative judgment rather than one absolute answer',
      ['self_preferential_bias'],
      'stop after candidates are deduped and compared against the rubric',
    )
  }
  if (
    containsAny(text, [
      'rename',
      'migration',
      'migrate',
      'refactor',
      'everywhere',
      'last 50',
      '80 resumes',
      'many',
      'batch',
      'parallel',
      '批量',
      '迁移',
      '重构',
      '全部',
      '到处',
      '并行',
    ])
  ) {
    return decision(
      'fanout_synthesize',
      'task can be split across files, items, or evidence sources',
      ['agentic_laziness', 'goal_drift'],
      'stop after all partitions report structured outputs and the synthesis is checked',
    )
  }
  if (mode === 'plan') {
    return decision(
      'single_turn',
      'plan mode keeps ordinary planning read-only and compact',
      ['goal_drift'],
      'stop after a clear plan artifact is produced',
    )
  }
  return decision(
    'single_turn',
    'ordinary coding turn does not need extra agent compute',
    [],
    'stop when the requested turn is answered or a tool boundary requires approval',
  )
}

/**
 * 为选定 harness 模式构建标准决策 payload（移植 _decision，harness.py:165-189）。
 * approvalBoundary 与 subagentContract 在所有模式下均为同一逐字内容。
 */
function decision(
  pattern: HarnessPattern,
  reason: string,
  failureModes: string[],
  stopCondition: string,
): HarnessDecision {
  return new HarnessDecision(
    pattern,
    [reason],
    failureModes,
    stopCondition,
    'Subagents are read-only by default; workspace mutation, shell risk, ' +
      'and memory rule changes return to the main agent or user approval.',
    {
      claim: 'state the explored conclusion',
      evidence: 'name files, memories, or tool outputs inspected',
      risk: 'surface uncertainty or missing evidence',
      confidence: 'low, medium, or high',
      nextAction: 'recommend the next bounded action',
    },
  )
}

/** 判断文本是否包含任一触发短语（移植 _contains_any，harness.py:192-195）。 */
function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle))
}
