#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const defaultCasesPath = join(repoRoot, 'evals', 'live-coding-tasks.json')
const defaultResultsPath = join(repoRoot, 'evals', 'results', 'live-latest.json')

/**
 * Parse release-gate flags and environment overrides.
 */
export function parseArgs(argv, env = process.env) {
  const config = {
    casesPath: defaultCasesPath,
    resultsPath: env.KODEKS_LIVE_EVAL_RESULTS
      ? resolve(env.KODEKS_LIVE_EVAL_RESULTS)
      : defaultResultsPath,
    maxAgeHours: numberFromEnv(env.KODEKS_LIVE_EVAL_MAX_AGE_HOURS, 72),
    minPassRate: numberFromEnv(env.KODEKS_LIVE_EVAL_MIN_PASS_RATE, 1),
    minConceptPassRate: numberFromEnv(env.KODEKS_LIVE_EVAL_MIN_CONCEPT_PASS_RATE, 1),
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cases') config.casesPath = resolve(requiredValue(argv, ++i, arg))
    else if (arg === '--results') config.resultsPath = resolve(requiredValue(argv, ++i, arg))
    else if (arg === '--max-age-hours') {
      config.maxAgeHours = Number(requiredValue(argv, ++i, arg))
    } else if (arg === '--min-pass-rate') {
      config.minPassRate = Number(requiredValue(argv, ++i, arg))
    } else if (arg === '--min-concept-pass-rate') {
      config.minConceptPassRate = Number(requiredValue(argv, ++i, arg))
    } else if (arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  assertFiniteThreshold('max-age-hours', config.maxAgeHours, 0, Number.POSITIVE_INFINITY)
  assertFiniteThreshold('min-pass-rate', config.minPassRate, 0, 1)
  assertFiniteThreshold('min-concept-pass-rate', config.minConceptPassRate, 0, 1)
  return config
}

/**
 * Convert an optional numeric environment value with a default.
 */
function numberFromEnv(value, fallback) {
  if (value === undefined || value === '') {
    return fallback
  }
  return Number(value)
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
 * Reject missing, NaN, or out-of-range numeric thresholds.
 */
function assertFiniteThreshold(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
}

/**
 * Print command help for local release and CI logs.
 */
function printHelp() {
  console.log(`Usage: npm run eval:live:check -- [options]

Options:
  --results <path>                 Live eval result JSON (default: ../evals/results/live-latest.json)
  --cases <path>                   Case manifest path (default: ../evals/live-coding-tasks.json)
  --max-age-hours <n>              Maximum accepted result age (default: 72)
  --min-pass-rate <0-1>            Minimum total pass rate (default: 1)
  --min-concept-pass-rate <0-1>    Minimum pass rate per concept (default: 1)

Environment overrides:
  KODEKS_LIVE_EVAL_RESULTS
  KODEKS_LIVE_EVAL_MAX_AGE_HOURS
  KODEKS_LIVE_EVAL_MIN_PASS_RATE
  KODEKS_LIVE_EVAL_MIN_CONCEPT_PASS_RATE`)
}

/**
 * Load JSON from disk with a path-aware error.
 */
function loadJson(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing file: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Return the canonical case ids from the manifest.
 */
function manifestCaseIds(manifest) {
  if (!Array.isArray(manifest.cases)) {
    throw new Error('Case manifest must contain a cases array')
  }
  return manifest.cases.map((testCase) => testCase.id)
}

/**
 * Validate a live eval report as a release-quality reliability gate.
 */
export function validateLiveEvalReport(report, manifest, config, now = new Date()) {
  const failures = []
  const caseIds = manifestCaseIds(manifest)
  const resultIds = Array.isArray(report.results) ? report.results.map((result) => result.id) : []
  const summary = report.summary || {}

  if (report.schemaVersion !== 1) {
    failures.push('schemaVersion must be 1')
  }

  const generatedAt = new Date(report.generatedAt)
  if (Number.isNaN(generatedAt.getTime())) {
    failures.push('generatedAt must be a valid timestamp')
  } else {
    const ageHours = (now.getTime() - generatedAt.getTime()) / 3_600_000
    if (ageHours < 0) {
      failures.push('generatedAt cannot be in the future')
    }
    if (ageHours > config.maxAgeHours) {
      failures.push(
        `live eval result is ${formatNumber(ageHours)}h old, above ${config.maxAgeHours}h`,
      )
    }
  }

  if (summary.total !== caseIds.length) {
    failures.push(`summary.total must equal manifest case count ${caseIds.length}`)
  }
  if (summary.passed + summary.failed !== summary.total) {
    failures.push('summary passed + failed must equal total')
  }
  if (summary.passRate < config.minPassRate) {
    failures.push(
      `summary pass rate ${formatPercent(summary.passRate)} is below ${formatPercent(
        config.minPassRate,
      )}`,
    )
  }

  const missingIds = caseIds.filter((id) => !resultIds.includes(id))
  const extraIds = resultIds.filter((id) => !caseIds.includes(id))
  const duplicateIds = resultIds.filter((id, index) => resultIds.indexOf(id) !== index)
  if (missingIds.length > 0) failures.push(`missing case results: ${missingIds.join(', ')}`)
  if (extraIds.length > 0) failures.push(`unknown case results: ${extraIds.join(', ')}`)
  if (duplicateIds.length > 0) failures.push(`duplicate case results: ${duplicateIds.join(', ')}`)

  const conceptFailures = Object.entries(summary.byConcept || {})
    .filter(([, concept]) => concept.passRate < config.minConceptPassRate)
    .map(
      ([concept, stats]) =>
        `${concept} ${formatPercent(stats.passRate)} < ${formatPercent(
          config.minConceptPassRate,
        )}`,
    )
  if (conceptFailures.length > 0) {
    failures.push(`concept pass rates below threshold: ${conceptFailures.join('; ')}`)
  }

  const totals = summary.totals || {}
  if ((totals.runtimeErrors || 0) > 0) {
    failures.push(`runtime error events must be zero, saw ${totals.runtimeErrors}`)
  }
  if ((totals.protectedFileFailures || 0) > 0) {
    failures.push(`protected file failures must be zero, saw ${totals.protectedFileFailures}`)
  }

  for (const result of Array.isArray(report.results) ? report.results : []) {
    if (result.protectedFiles?.passed === false) {
      failures.push(`${result.id} changed protected files: ${result.protectedFiles.changed}`)
    }
    if (config.minPassRate === 1 && result.passed !== true) {
      failures.push(`${result.id} did not pass: ${(result.failures || []).join(', ')}`)
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  }
}

/**
 * Format a decimal number with stable precision for diagnostics.
 */
function formatNumber(value) {
  return Math.round(value * 100) / 100
}

/**
 * Format a pass-rate decimal as a readable percentage.
 */
function formatPercent(value) {
  return `${formatNumber(value * 100)}%`
}

/**
 * Program entrypoint for release checks.
 */
export function main(argv = process.argv.slice(2), env = process.env) {
  const config = parseArgs(argv, env)
  const manifest = loadJson(config.casesPath)
  const report = loadJson(config.resultsPath)
  const result = validateLiveEvalReport(report, manifest, config)
  if (!result.passed) {
    console.error('Live eval release gate failed:')
    for (const failure of result.failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
    return
  }
  console.log(
    `Live eval release gate passed: ${report.summary.passed}/${report.summary.total} cases ` +
      `(${formatPercent(report.summary.passRate)})`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
