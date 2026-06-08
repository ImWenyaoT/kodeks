// frontend/lib/server/agent/context.ts
// 运行时 context 装配：逐字节忠实移植自 Python src/kodeks/runtime_context.py。
// bodyWithRuntimeContext / buildRuntimeInstructions（逐字指令行）/ selectedFilesFromBody /
// buildMemoryContext（recall_layered(5,[atom,artifact]) + 按词回退）/ memoryContextIds（仅 atoms）/
// memoryContextLayerCounts（{atom,artifact}）/ 各 formatter（逐字文案）。
//
// 保真红线（见 30-runtime-loop.md「Context 装配」+「逐字契约」、80-oracle §B）：
//  · preamble 5 行、plan 追加行、区段标题（Selected workspace files for this turn: / Recalled memory: / Active plan:）逐字。
//  · memory_ids 仅取 atoms 层 item.id；layer_counts 映射 {atoms:atom,artifacts:artifact} 且只保留非零。
//  · 回退 terms：去标点，len>=4 或含中文(U+4E00..U+9FFF)，最多 6 个。
//  · instructions 合并：existing 非空时 `${existing}\n\n${instructions}`，否则直接用新值。
import type { LayeredRecall, RecalledArtifact, RecalledAtom, StoredPlanArtifact } from '../storage'
import type { HarnessDecision } from './harness'

/** memory context 结构（recall_layered 返回 {atoms, artifacts}，runtime_context.py 用 dict）。 */
export type MemoryContext = LayeredRecall

/** selected file 上下文项（selected_files_from_body 归一化结果）。 */
export interface SelectedFile {
  path: string
  content: string | null
  error: string | null
  truncated: boolean
}

/** buildMemoryContext 所需的最小内存数据库接口（异步，M2 存储）。 */
export interface MemoryRecallSource {
  memories: {
    recallLayered(query: string, limit: number, layers: string[]): Promise<LayeredRecall>
  }
}

/**
 * 添加面向模型的运行时 context，同时保留原请求 body（移植 body_with_runtime_context，runtime_context.py:12-32）。
 * next_body.mode = mode；若构造出 instructions 非空，与 body 已有 instructions 用空行合并，否则直接用新值。
 */
export function bodyWithRuntimeContext(
  body: Record<string, unknown>,
  mode: string,
  activePlan: StoredPlanArtifact | null,
  memoryContext: MemoryContext,
  selectedFiles: SelectedFile[],
  harnessDecision: HarnessDecision | null = null,
): Record<string, unknown> {
  const nextBody: Record<string, unknown> = { ...body }
  nextBody.mode = mode
  const instructions = buildRuntimeInstructions(
    mode,
    activePlan,
    memoryContext,
    selectedFiles,
    harnessDecision,
  )
  if (instructions) {
    const existing = stringValue(body.instructions)
    nextBody.instructions =
      existing === undefined ? instructions : `${existing}\n\n${instructions}`
  }
  return nextBody
}

/**
 * 构建紧凑的面向模型指令以保持 Python 运行时一致（移植 build_runtime_instructions，runtime_context.py:35-74）。
 * 固定顺序拼接：preamble → (plan 行) → (harness) → selected files → recalled memory → (active plan)。
 */
export function buildRuntimeInstructions(
  mode: string,
  activePlan: StoredPlanArtifact | null,
  memoryContext: MemoryContext,
  selectedFiles: SelectedFile[],
  harnessDecision: HarnessDecision | null = null,
): string {
  const lines: string[] = [
    'You are Kodeks, a local-first coding agent.',
    "Reply in the user's language.",
    'Do not reveal hidden reasoning.',
    'Use function tools for workspace facts; do not write tool-call JSON in visible text.',
    'run_shell executes one command as plain argv without a shell; do not use pipes, redirects, variables, command substitution, semicolons, or control operators.',
  ]
  if (mode === 'plan') {
    lines.push('Plan mode is read-only; use only read-only tools.')
  }
  if (harnessDecision !== null) {
    lines.push('', formatHarnessDecision(harnessDecision))
  }
  lines.push('', 'Selected workspace files for this turn:', formatSelectedFilesContext(selectedFiles))
  lines.push('', 'Recalled memory:', formatMemoryContext(memoryContext))
  if (activePlan !== null) {
    lines.push('', 'Active plan:', `Title: ${activePlan.title}`, `Summary: ${activePlan.summary}`)
    for (const step of activePlan.steps) {
      lines.push(`- [${step.status}] ${step.title}`)
    }
  }
  return lines.join('\n')
}

/**
 * 从 camelCase 或 snake_case payload 读取用户选定文件 context（移植 selected_files_from_body，runtime_context.py:77-102）。
 * selectedFiles 优先；非列表返回 []；逐项要求 path 为非空 str，归一 content/error/truncated。
 */
export function selectedFilesFromBody(body: Record<string, unknown>): SelectedFile[] {
  let value = body.selectedFiles
  if (value === undefined || value === null) {
    value = body.selected_files
  }
  if (!Array.isArray(value)) {
    return []
  }
  const selected: SelectedFile[] = []
  for (const item of value) {
    if (!isDict(item)) {
      continue
    }
    const path = stringValue(item.path)
    if (path === undefined) {
      continue
    }
    selected.push({
      path,
      content: typeof item.content === 'string' ? item.content : null,
      error: typeof item.error === 'string' ? item.error : null,
      truncated: item.truncated === true,
    })
  }
  return selected
}

/**
 * 为当前用户输入分层召回记忆（移植 build_memory_context，runtime_context.py:105-132）。
 * 先 recall_layered(query,5,[atom,artifact])；命中（memory_ids 非空）即返回。
 * 否则按 fallback terms 逐词召回去重合并（按 id 或 refId 去重）。
 */
export async function buildMemoryContext(
  database: MemoryRecallSource,
  query: string,
): Promise<MemoryContext> {
  const layers = ['atom', 'artifact']
  const context = await database.memories.recallLayered(query, 5, layers)
  if (memoryContextIds(context).length > 0) {
    return context
  }
  const merged: MemoryContext = { atoms: [], artifacts: [] }
  const seen = new Set<string>()
  for (const term of memoryQueryTerms(query)) {
    const recalled = await database.memories.recallLayered(term, 5, layers)
    // 与 Python 一致：遍历两层的行，按 id 或 refId 去重后追加进对应层。
    for (const layer of ['atoms', 'artifacts'] as const) {
      for (const row of recalled[layer]) {
        const rowId = String(
          (row as { id?: unknown }).id || (row as { refId?: unknown }).refId || '',
        )
        if (!rowId || seen.has(rowId)) {
          continue
        }
        seen.add(rowId)
        merged[layer].push(row as RecalledAtom & RecalledArtifact)
      }
    }
  }
  return merged
}

/**
 * 返回应在 memory_recalled 事件中暴露的记忆 id（移植 memory_context_ids，runtime_context.py:135-144）。
 * 仅取 atoms 层的字符串 id。
 */
export function memoryContextIds(context: MemoryContext): string[] {
  const ids: string[] = []
  for (const item of context.atoms ?? []) {
    if (typeof item.id === 'string') {
      ids.push(item.id)
    }
  }
  return ids
}

/**
 * 统计召回的记忆层数供 UI 展示（移植 memory_context_layer_counts，runtime_context.py:147-161）。
 * 映射 {atoms:atom, artifacts:artifact}，只保留非零计数。
 */
export function memoryContextLayerCounts(context: MemoryContext): Record<string, number> {
  const counts: Record<string, number> = {}
  const mapping: Array<['atoms' | 'artifacts', string]> = [
    ['atoms', 'atom'],
    ['artifacts', 'artifact'],
  ]
  for (const [key, label] of mapping) {
    const count = (context[key] ?? []).length
    if (count) {
      counts[label] = count
    }
  }
  return counts
}

/**
 * 把选定工作区文件格式化为有界模型 context（移植 _format_selected_files_context，runtime_context.py:164-179）。
 * 空时 "No files selected."；非空带前导说明 + 每文件 "--- path (truncated) ---" + error 或 content。
 */
function formatSelectedFilesContext(selectedFiles: SelectedFile[]): string {
  if (selectedFiles.length === 0) {
    return 'No files selected.'
  }
  const lines: string[] = [
    'The user explicitly selected these workspace files. Use them as high-priority context when relevant. If a file is truncated or an answer needs more detail, call read_file with its path.',
  ]
  for (const file of selectedFiles) {
    const suffix = file.truncated === true ? ' (truncated)' : ''
    lines.push(`\n--- ${file.path}${suffix} ---`)
    if (typeof file.error === 'string') {
      lines.push(`Unable to read selected file: ${file.error}`)
      continue
    }
    lines.push(String(file.content || ''))
  }
  return lines.join('\n')
}

/**
 * 把分层记忆格式化为紧凑模型指令（移植 _format_memory_context，runtime_context.py:182-195）。
 * atom 行：`- [atom:scope] content`；artifact 行：`- [artifact:refId] summary (use read_memory_artifact ...)`。
 * 空时 "No recalled memories."。
 */
function formatMemoryContext(context: MemoryContext): string {
  const lines: string[] = []
  for (const atom of context.atoms ?? []) {
    const scope = (atom as { scope?: unknown }).scope || 'project'
    const content = (atom as { content?: unknown }).content || ''
    lines.push(`- [atom:${scope}] ${content}`)
  }
  for (const artifact of context.artifacts ?? []) {
    const refId =
      (artifact as { refId?: unknown }).refId || (artifact as { id?: unknown }).id || 'artifact'
    const summary = (artifact as { summary?: unknown }).summary || ''
    lines.push(`- [artifact:${refId}] ${summary} (use read_memory_artifact to inspect full output)`)
  }
  return lines.length > 0 ? lines.join('\n') : 'No recalled memories.'
}

/**
 * 把选定的 harness 模式格式化为紧凑模型指引（移植 _format_harness_decision，runtime_context.py:198-216）。
 * 逐字行：Harness pattern for this turn / Why / Stop condition / Approval boundary / (Failure modes) / 子代理契约提示。
 */
function formatHarnessDecision(decision: HarnessDecision): string {
  const lines: string[] = [
    `Harness pattern for this turn: ${decision.pattern}.`,
    `Why: ${decision.reasons.join('; ')}.`,
    `Stop condition: ${decision.stopCondition}.`,
    `Approval boundary: ${decision.approvalBoundary}`,
  ]
  if (decision.failureModes.length > 0) {
    lines.push('Failure modes to guard against: ' + decision.failureModes.join(', ') + '.')
  }
  lines.push(
    'If using spawn_explore_agent, expect its summary to support claim, evidence, risk, confidence, and nextAction.',
  )
  return lines.join('\n')
}

/**
 * 为简单字面记忆搜索抽取稳定的回退 terms（移植 _memory_query_terms，runtime_context.py:219-227）。
 * 把 ? / ？ 替换为空格后按空白切分；每词去首尾标点；len>=4 或含中文(U+4E00..U+9FFF)则保留；最多 6 个。
 */
function memoryQueryTerms(query: string): string[] {
  const terms: string[] = []
  // 对应 Python query.replace("?"," ").replace("？"," ").split()：按任意空白序列切分并丢空段。
  const raws = query.replace(/\?/g, ' ').replace(/？/g, ' ').split(/\s+/).filter((t) => t.length > 0)
  for (const raw of raws) {
    // 对应 Python str.strip(".,:;!()[]{}'\"")：去首尾这些标点字符。
    const term = stripPunctuation(raw)
    if (term.length >= 4 || hasChinese(term)) {
      terms.push(term)
    }
  }
  return terms.slice(0, 6)
}

/** 去掉字符串首尾连续的指定标点（对应 Python str.strip(".,:;!()[]{}'\"")）。 */
function stripPunctuation(value: string): string {
  const punctuation = new Set([
    '.',
    ',',
    ':',
    ';',
    '!',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    "'",
    '"',
  ])
  let start = 0
  let end = value.length
  while (start < end && punctuation.has(value[start])) {
    start += 1
  }
  while (end > start && punctuation.has(value[end - 1])) {
    end -= 1
  }
  return value.slice(start, end)
}

/** 判断字符串是否含中文字符（码点 U+4E00..U+9FFF，对应 Python "一" <= char <= "鿿"）。 */
function hasChinese(term: string): boolean {
  for (const char of term) {
    const code = char.codePointAt(0)
    if (code !== undefined && code >= 0x4e00 && code <= 0x9fff) {
      return true
    }
  }
  return false
}

/**
 * 复刻 Python `_string_value`：仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 undefined。
 * （runtime_context.py:230-233 的 _string_value）
 */
function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return undefined
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
