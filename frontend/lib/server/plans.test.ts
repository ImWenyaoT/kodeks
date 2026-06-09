// frontend/lib/server/plans.test.ts
// plan-mode 计划解析行为测试：覆盖 buildPlanArtifactContent 的 title/summary/steps 提取、
// _compactText 折叠与截断、step marker 识别（checkbox/bullet/数字编号含中文顿号）、回退路径。
import { describe, expect, it } from 'vitest'
import { buildPlanArtifactContent } from './plans'

describe('buildPlanArtifactContent', () => {
  it('从 markdown heading + 步骤抽取 title/summary/steps', () => {
    const result = buildPlanArtifactContent('请帮我做计划', [
      '# Migrate tools subsystem',
      'Port the nine tools to TypeScript.',
      '1. Read the spec',
      '2. Write the code',
      '- [x] Done item',
    ].join('\n'))

    expect(result.title).toBe('Migrate tools subsystem')
    expect(result.summary).toBe('Port the nine tools to TypeScript.')
    expect(result.steps).toEqual([
      { id: 'step_1', title: 'Read the spec', status: 'pending', details: null },
      { id: 'step_2', title: 'Write the code', status: 'pending', details: null },
      { id: 'step_3', title: 'Done item', status: 'completed', details: null },
    ])
  })

  it('无 heading 时首个非 step 行作 title（去尾 :：）', () => {
    const result = buildPlanArtifactContent('prompt', ['Plan overview：', '- first step'].join('\n'))
    expect(result.title).toBe('Plan overview')
    // title 由 rstripColons 去掉了尾部 '：'，而 summary 候选的 normalized 仍含 '：'，
    // 故 normalized !== title，该行成为合法 summary（compact 后保留尾部 '：'）。
    expect(result.summary).toBe('Plan overview：')
    expect(result.steps).toEqual([
      { id: 'step_1', title: 'first step', status: 'pending', details: null },
    ])
  })

  it('summary 排除 summary/steps/plan 与 摘要/计划/步骤 标签行', () => {
    const result = buildPlanArtifactContent('prompt', [
      '# Title here',
      'Summary:',
      '步骤',
      'Real summary line.',
      '* a step',
    ].join('\n'))
    expect(result.title).toBe('Title here')
    expect(result.summary).toBe('Real summary line.')
  })

  it('数字编号支持 . ) 与中文顿号 、', () => {
    const result = buildPlanArtifactContent('prompt', [
      'Heading line',
      '1.first',
      '2)second',
      '3、third',
    ].join('\n'))
    expect(result.steps.map((s) => s.title)).toEqual(['first', 'second', 'third'])
    expect(result.steps.map((s) => s.id)).toEqual(['step_1', 'step_2', 'step_3'])
  })

  it('无 steps 时回退单步，title 用 summary', () => {
    const result = buildPlanArtifactContent('user wants X', 'Just a single descriptive line.')
    expect(result.title).toBe('Just a single descriptive line.')
    // 只有一行且即 title；summary 候选须 != title → 无 → 回退 compact(assistant_text,240) === 该行。
    expect(result.summary).toBe('Just a single descriptive line.')
    expect(result.steps).toEqual([
      { id: 'step_1', title: 'Just a single descriptive line.', status: 'pending', details: null },
    ])
  })

  it('空 assistant_text 时 title 回退 user_prompt，再回退 "Kodeks plan"', () => {
    expect(buildPlanArtifactContent('do the thing', '').title).toBe('do the thing')
    expect(buildPlanArtifactContent('', '').title).toBe('Kodeks plan')
    // 空时 steps 回退单步，summary 为空 → title "Review the generated plan"。
    expect(buildPlanArtifactContent('', '').steps[0].title).toBe('Review the generated plan')
  })

  it('_compactText 折叠空白并截到 max-1（无省略号）', () => {
    // 81 字符的 heading，title 上限 80 → 截到 79 再 rstrip。
    const long = 'x'.repeat(200)
    const result = buildPlanArtifactContent('prompt', `# ${long}`)
    expect(result.title.length).toBe(79)
    // 折叠多空白为单空格。
    const collapsed = buildPlanArtifactContent('prompt', '#   a    b   c')
    expect(collapsed.title).toBe('a b c')
  })

  it('checkbox 状态：[x]/[X] → completed，[ ] → pending', () => {
    const result = buildPlanArtifactContent('p', [
      '- [ ] todo one',
      '- [X] done upper',
      '* [x] done lower',
    ].join('\n'))
    expect(result.steps.map((s) => s.status)).toEqual(['pending', 'completed', 'completed'])
  })
})
