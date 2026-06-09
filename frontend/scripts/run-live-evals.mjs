#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const defaultCasesPath = join(repoRoot, 'evals', 'live-coding-tasks.json')
const defaultResultsPath = join(repoRoot, 'evals', 'results', 'live-latest.json')
const defaultWorkspacePath = join(repoRoot, 'evals', 'workspace-live')

/**
 * Parse supported CLI flags into a small config object.
 */
export function parseArgs(argv, env = process.env) {
  const config = {
    baseUrl: env.KODEKS_EVAL_BASE_URL || 'http://127.0.0.1:3000',
    casesPath: defaultCasesPath,
    outputPath: defaultResultsPath,
    limit: null,
    caseId: null,
    workspace: env.KODEKS_EVAL_WORKSPACE || defaultWorkspacePath,
    controlToken: env.KODEKS_EVAL_CONTROL_TOKEN || env.KODEKS_CONTROL_TOKEN || '',
    keepWorkspace: false,
    resetWorkspace: false,
    timeoutMs: 120_000,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--base-url') config.baseUrl = requiredValue(argv, ++i, arg)
    else if (arg === '--cases') config.casesPath = resolve(requiredValue(argv, ++i, arg))
    else if (arg === '--out') config.outputPath = resolve(requiredValue(argv, ++i, arg))
    else if (arg === '--limit') config.limit = Number(requiredValue(argv, ++i, arg))
    else if (arg === '--case') config.caseId = requiredValue(argv, ++i, arg)
    else if (arg === '--workspace') config.workspace = resolve(requiredValue(argv, ++i, arg))
    else if (arg === '--control-token') config.controlToken = requiredValue(argv, ++i, arg)
    else if (arg === '--timeout-ms') config.timeoutMs = Number(requiredValue(argv, ++i, arg))
    else if (arg === '--keep-workspace') config.keepWorkspace = true
    else if (arg === '--reset-workspace') config.resetWorkspace = true
    else if (arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return config
}

/**
 * Read the value after a CLI flag or throw a targeted error.
 */
function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

/**
 * Print the short command help for humans and CI logs.
 */
function printHelp() {
  console.log(`Usage: npm run eval:live -- [options]

Options:
  --base-url <url>       Kodeks server URL (default: http://127.0.0.1:3000)
  --cases <path>         Case manifest path (default: ../evals/live-coding-tasks.json)
  --out <path>           Result JSON path (default: ../evals/results/live-latest.json)
  --limit <n>            Run only the first n selected cases
  --case <id>            Run one case by id
  --workspace <path>     Reuse or create a benchmark workspace (default: ../evals/workspace-live)
  --control-token <tok>  Bearer token for protected Kodeks control APIs
  --timeout-ms <n>       Per-case request timeout (default: 120000)
  --reset-workspace      Delete the selected workspace before writing cases
  --keep-workspace       Do not delete generated temp workspaces

Environment:
  KODEKS_EVAL_CONTROL_TOKEN or KODEKS_CONTROL_TOKEN can provide the control token`)
}

/**
 * Load and validate the live eval case manifest.
 */
function loadCases(casesPath) {
  const manifest = JSON.parse(readFileSync(casesPath, 'utf8'))
  if (!Array.isArray(manifest.cases)) {
    throw new Error('Case manifest must contain a cases array')
  }
  return manifest.cases
}

/**
 * Select cases according to --case and --limit.
 */
function selectCases(cases, config) {
  let selected = cases
  if (config.caseId) {
    selected = selected.filter((entry) => entry.id === config.caseId)
    if (selected.length === 0) {
      throw new Error(`Unknown case id: ${config.caseId}`)
    }
  }
  if (Number.isFinite(config.limit) && config.limit > 0) {
    selected = selected.slice(0, config.limit)
  }
  return selected
}

/**
 * Create the benchmark workspace and materialize every selected case file.
 */
function prepareWorkspace(cases, config) {
  const workspace =
    config.workspace ||
    join(tmpdir(), `kodeks-live-evals-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const isDefaultWorkspace = workspace === defaultWorkspacePath
  if (existsSync(workspace) && (isDefaultWorkspace || config.resetWorkspace)) {
    rmSync(workspace, { recursive: true, force: true })
  }
  if (existsSync(workspace) && !isDefaultWorkspace && !config.resetWorkspace) {
    throw new Error(
      `Workspace already exists: ${workspace}. Pass --reset-workspace to replace it.`,
    )
  }
  mkdirSync(workspace, { recursive: true })
  for (const testCase of cases) {
    for (const [relativePath, content] of Object.entries(testCase.files || {})) {
      const target = join(workspace, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
    }
  }
  return workspace
}

/**
 * Build the prompt sent to Kodeks for one case.
 */
function buildPrompt(testCase) {
  const verify = [testCase.verify.command, ...(testCase.verify.args || [])].join(' ')
  return [
    `You are fixing one benchmark case inside ${testCase.workdir}.`,
    'Use the workspace tools to inspect and edit files.',
    'Do not modify other benchmark cases.',
    'Do not modify verifier or test files; the evaluator checks their hashes.',
    `Task: ${testCase.prompt}`,
    `Verifier: run ${verify} from ${testCase.workdir}.`,
    'Finish only after the verifier should pass.',
  ].join('\n')
}

/**
 * POST one case to the Kodeks SSE endpoint and parse runtime events.
 */
export async function runKodeksCase(testCase, config, signal) {
  const url = new URL('/api/chat/stream', config.baseUrl)
  const startedAt = performance.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify({
      input: buildPrompt(testCase),
      mode: 'act',
      session_id: `eval_${testCase.id}_${Date.now()}`,
      selectedFiles: Object.keys(testCase.files || {}),
    }),
    signal,
  })
  const text = await response.text()
  const events = parseSse(text)
  return {
    statusCode: response.status,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    events,
    rawBytes: Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * Build request headers for the protected control API.
 */
export function requestHeaders(config) {
  return {
    'Content-Type': 'application/json',
    ...(config.controlToken ? { Authorization: `Bearer ${config.controlToken}` } : {}),
  }
}

/**
 * Parse a text/event-stream body into event records.
 */
function parseSse(text) {
  const events = []
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    const eventLine = lines.find((line) => line.startsWith('event: '))
    const dataLines = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
    if (!eventLine || dataLines.length === 0) {
      continue
    }
    let payload
    try {
      payload = JSON.parse(dataLines.join('\n'))
    } catch {
      payload = { raw: dataLines.join('\n') }
    }
    events.push({ event: eventLine.slice('event: '.length), payload })
  }
  return events
}

/**
 * Return protected files whose contents must not change during the case.
 */
function protectedFiles(testCase) {
  if (Array.isArray(testCase.protectedFiles) && testCase.protectedFiles.length > 0) {
    return testCase.protectedFiles
  }
  return Object.keys(testCase.files || {}).filter((relativePath) =>
    /(^|\/)([^/]+\.)?(test|spec)\.[cm]?js$/.test(relativePath),
  )
}

/**
 * Hash protected files before the model can edit the workspace.
 */
function snapshotProtectedFiles(testCase, workspace) {
  const snapshots = {}
  for (const relativePath of protectedFiles(testCase)) {
    const target = join(workspace, relativePath)
    snapshots[relativePath] = fileSha256(target)
  }
  return snapshots
}

/**
 * Compare protected files after the model run and report tampering.
 */
function checkProtectedFiles(snapshots, workspace) {
  const changed = []
  for (const [relativePath, before] of Object.entries(snapshots)) {
    const target = join(workspace, relativePath)
    const after = existsSync(target) ? fileSha256(target) : null
    if (before !== after) {
      changed.push(relativePath)
    }
  }
  return {
    passed: changed.length === 0,
    changed,
  }
}

/**
 * Compute a stable SHA256 digest for a file.
 */
function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Run the case verifier with plain argv and no shell.
 */
function runVerifier(testCase, workspace) {
  const cwd = join(workspace, testCase.workdir)
  return new Promise((resolveVerifier) => {
    const startedAt = performance.now()
    const child = spawn(testCase.verify.command, testCase.verify.args || [], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      resolveVerifier({
        exitCode: code,
        passed: code === 0,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      })
    })
  })
}

/**
 * Convert runtime events into reliability counters.
 */
function summarizeEvents(events) {
  const counts = {}
  for (const event of events) {
    const type = event.payload?.type || event.event
    counts[type] = (counts[type] || 0) + 1
  }
  return {
    counts,
    toolCalls: counts.tool_call || 0,
    toolResults: counts.tool_result || 0,
    approvals: counts.approval_required || 0,
    errors: counts.error || 0,
    completed: Boolean(counts.response_completed),
  }
}

/**
 * Limit large verifier output while preserving debugging signal.
 */
function truncate(text, max = 4000) {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max)}\n...<truncated>`
}

/**
 * Run one eval case end to end and return its result record.
 */
async function evaluateCase(testCase, config, workspace) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  const protectedSnapshot = snapshotProtectedFiles(testCase, workspace)
  try {
    const runtime = await runKodeksCase(testCase, config, controller.signal)
    const protectedCheck = checkProtectedFiles(protectedSnapshot, workspace)
    const verifier = await runVerifier(testCase, workspace)
    const eventSummary = summarizeEvents(runtime.events)
    return {
      id: testCase.id,
      concept: testCase.concept,
      passed:
        runtime.statusCode === 200 &&
        eventSummary.completed &&
        protectedCheck.passed &&
        verifier.passed,
      failures: [
        ...(runtime.statusCode === 200 ? [] : [`http_${runtime.statusCode}`]),
        ...(eventSummary.completed ? [] : ['missing_response_completed']),
        ...(eventSummary.errors === 0 ? [] : ['runtime_error_event']),
        ...(protectedCheck.passed
          ? []
          : [`protected_files_changed:${protectedCheck.changed.join(',')}`]),
        ...(verifier.passed ? [] : [`verifier_exit_${verifier.exitCode}`]),
      ],
      protectedFiles: protectedCheck,
      runtime,
      eventSummary,
      verifier,
    }
  } catch (error) {
    return {
      id: testCase.id,
      concept: testCase.concept,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      protectedFiles: null,
      runtime: null,
      eventSummary: null,
      verifier: null,
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Build aggregate reliability metrics from per-case results.
 */
function summarizeResults(results) {
  const passed = results.filter((result) => result.passed).length
  const failed = results.length - passed
  const byConcept = {}
  for (const result of results) {
    const current = byConcept[result.concept] || { passed: 0, total: 0, passRate: 0 }
    current.total += 1
    if (result.passed) current.passed += 1
    current.passRate = current.total === 0 ? 0 : current.passed / current.total
    byConcept[result.concept] = current
  }
  return {
    passed,
    failed,
    total: results.length,
    passRate: results.length === 0 ? 0 : passed / results.length,
    byConcept,
    totals: {
      toolCalls: sum(results, (result) => result.eventSummary?.toolCalls || 0),
      toolResults: sum(results, (result) => result.eventSummary?.toolResults || 0),
      approvals: sum(results, (result) => result.eventSummary?.approvals || 0),
      runtimeErrors: sum(results, (result) => result.eventSummary?.errors || 0),
      protectedFileFailures: results.filter((result) => result.protectedFiles?.passed === false)
        .length,
    },
  }
}

/**
 * Sum a numeric projection across result rows.
 */
function sum(rows, project) {
  return rows.reduce((total, row) => total + project(row), 0)
}

/**
 * Program entrypoint.
 */
async function main() {
  const config = parseArgs(process.argv.slice(2))
  const cases = selectCases(loadCases(config.casesPath), config)
  const workspace = prepareWorkspace(cases, config)
  const results = []
  console.log(`Running ${cases.length} live eval case(s) against ${config.baseUrl}`)
  console.log(`Workspace: ${workspace}`)
  for (const testCase of cases) {
    const result = await evaluateCase(testCase, config, workspace)
    results.push(result)
    const status = result.passed ? 'PASS' : 'FAIL'
    console.log(`${status} ${testCase.id} ${result.failures.join(', ')}`)
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    workspace,
    summary: summarizeResults(results),
    results,
  }
  mkdirSync(dirname(config.outputPath), { recursive: true })
  writeFileSync(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${config.outputPath}`)
  if (!config.keepWorkspace && workspace.startsWith(tmpdir())) {
    rmSync(workspace, { recursive: true, force: true })
  }
  if (report.summary.failed > 0) {
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
