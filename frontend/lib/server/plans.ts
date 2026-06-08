// frontend/lib/server/plans.ts
// plan-mode 计划解析助手：逐字节忠实移植 Python src/kodeks/plans.py。
// title/summary/steps 提取 + _compactText 折叠空白 + step marker 识别，全部逐字。
//
// 保真红线（见 50-tools-security.md §6）：
//  · _compact_text：折叠所有空白后 trim；超长截到 max-1 再 rstrip（无省略号）。
//  · title 三级回退：# heading → 首个非 step 行（去尾 :：）→ user_prompt → "Kodeks plan"。
//  · summary 候选行先 lstrip('#') 再 strip，须 != title、非 step、去尾后不在中英排除集；否则 assistant_text。
//  · steps：checkbox/bullet/数字编号（. ) 、）识别；id=step_<n>；status 由 "[x]" 大小写无关判定。
//  · 无 steps 回退单步 {step_1, summary or "Review the generated plan", pending, null}。
import type { StoredPlanStep } from './storage'

/** build_plan_artifact_content 的返回形状（title/summary/steps）。 */
export interface PlanArtifactContent {
  title: string
  summary: string
  steps: StoredPlanStep[]
}

/**
 * 从 plan-mode 助手回答抽取最小结构化计划（移植 build_plan_artifact_content，plans.py:8-30）。
 * lines = assistant_text 去空白后的非空行。title/summary/steps 三段提取，steps 为空时回退单步。
 * @param userPrompt 用户原始提示（title 兜底）。
 * @param assistantText 助手 plan-mode 回答（解析来源）。
 */
export function buildPlanArtifactContent(
  userPrompt: string,
  assistantText: string,
): PlanArtifactContent {
  const lines = assistantText
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const title =
    readPlanTitle(lines) || compactText(userPrompt, 80) || 'Kodeks plan'
  const summary = readPlanSummary(lines, title) || compactText(assistantText, 240)
  let steps = readPlanSteps(lines)
  if (steps.length === 0) {
    steps = [
      {
        id: 'step_1',
        title: summary || 'Review the generated plan',
        status: 'pending',
        details: null,
      },
    ]
  }
  return { title, summary, steps }
}

/**
 * 读取 markdown heading 或首个短非 step 行作为计划标题（移植 _read_plan_title，plans.py:33-42）。
 * 优先 # 开头行（去 # 后 compact 80）；否则首个非 step 行（去尾 :： 后 compact 80）；都无返回 null。
 */
function readPlanTitle(lines: string[]): string | null {
  for (const line of lines) {
    if (line.startsWith('#')) {
      return compactText(stripLeadingHashes(line).trim(), 80)
    }
  }
  for (const line of lines) {
    if (!isPlanStepLine(line)) {
      return compactText(rstripColons(line), 80)
    }
  }
  return null
}

/**
 * 读取首个简明的非 heading 非 step 行作为摘要（移植 _read_plan_summary，plans.py:45-58）。
 * 候选行先 lstrip('#') 再 strip；须非空、!= title、非 step、去尾 :： 后小写不在 {summary,steps,plan}、
 * 原文去尾不在 {摘要,计划,步骤}。命中则 compact 240；都无返回 null。
 */
function readPlanSummary(lines: string[], title: string): string | null {
  for (const line of lines) {
    const normalized = stripLeadingHashes(line).trim()
    if (
      normalized &&
      normalized !== title &&
      !isPlanStepLine(line) &&
      !['summary', 'steps', 'plan'].includes(rstripColons(normalized).toLowerCase()) &&
      !['摘要', '计划', '步骤'].includes(rstripColons(normalized))
    ) {
      return compactText(normalized, 240)
    }
  }
  return null
}

/**
 * 从 numbered/bulleted/checkbox 行抽取计划 steps（移植 _read_plan_steps，plans.py:61-77）。
 * 每步 id=step_<len+1>，title compact 160，status 由 "[x]"（大小写无关）判 completed/pending，details=null。
 */
function readPlanSteps(lines: string[]): StoredPlanStep[] {
  const steps: StoredPlanStep[] = []
  for (const line of lines) {
    const title = planStepTitle(line)
    if (title === null) {
      continue
    }
    steps.push({
      id: `step_${steps.length + 1}`,
      title: compactText(title, 160),
      status: line.toLowerCase().includes('[x]') ? 'completed' : 'pending',
      details: null,
    })
  }
  return steps
}

/** 判断一行是否像 markdown 计划步骤（移植 _is_plan_step_line，plans.py:80-83）。 */
function isPlanStepLine(line: string): boolean {
  return planStepTitle(line) !== null
}

/**
 * 从常见 markdown 标记返回规范化的步骤标题（移植 _plan_step_title，plans.py:86-101）。
 * checkbox markers → bullet markers → 数字编号（开头连续数字后跟 . ) 、）。都不命中返回 null。
 */
function planStepTitle(line: string): string | null {
  const stripped = line.trim()
  for (const marker of ['- [ ] ', '- [x] ', '- [X] ', '* [ ] ', '* [x] ', '* [X] ']) {
    if (stripped.startsWith(marker)) {
      return stripped.slice(marker.length).trim()
    }
  }
  for (const marker of ['- ', '* ']) {
    if (stripped.startsWith(marker)) {
      return stripped.slice(marker.length).trim()
    }
  }
  let index = 0
  while (index < stripped.length && isDigit(stripped[index])) {
    index += 1
  }
  if (index > 0 && index < stripped.length && ['.', ')', '、'].includes(stripped[index])) {
    return stripped.slice(index + 1).trim()
  }
  return null
}

/**
 * 折叠空白并裁剪过长模型文本以稳定 plan 字段（移植 _compact_text，plans.py:104-110）。
 * normalized = 折叠所有空白后 trim；len<=max 原样返回；否则截到 max-1（max-1<0 时为 0）再 rstrip（无省略号）。
 */
function compactText(text: string, maxLength: number): string {
  // " ".join(text.split())：按任意空白序列切分并用单空格连接，等价折叠全部空白。
  const normalized = text.split(/\s+/).filter((token) => token.length > 0).join(' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }
  return normalized.slice(0, Math.max(0, maxLength - 1)).replace(/\s+$/, '')
}

/** 去掉行首连续的 '#'（对应 Python str.lstrip("#")）。 */
function stripLeadingHashes(line: string): string {
  return line.replace(/^#+/, '')
}

/** 去掉尾部连续的 ':' 与 '：'（对应 Python str.rstrip(":：")）。 */
function rstripColons(value: string): string {
  return value.replace(/[:：]+$/, '')
}

/** 判断一个字符是否 ASCII 数字（对应 Python str.isdigit() 在此上下文的用法）。 */
function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}
