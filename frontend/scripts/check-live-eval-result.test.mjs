import { describe, expect, it } from 'vitest'
import { validateLiveEvalReport } from './check-live-eval-result.mjs'

const config = {
  maxAgeHours: 72,
  minPassRate: 1,
  minConceptPassRate: 1,
}
const now = new Date('2026-06-09T12:00:00.000Z')

/**
 * Build a tiny valid manifest fixture for release-gate tests.
 */
function manifestFixture() {
  return {
    schemaVersion: 1,
    cases: [
      { id: 'case-one', concept: 'editing' },
      { id: 'case-two', concept: 'safety' },
    ],
  }
}

/**
 * Build a tiny valid live eval report fixture.
 */
function reportFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-09T11:00:00.000Z',
    summary: {
      passed: 2,
      failed: 0,
      total: 2,
      passRate: 1,
      byConcept: {
        editing: { passed: 1, total: 1, passRate: 1 },
        safety: { passed: 1, total: 1, passRate: 1 },
      },
      totals: {
        runtimeErrors: 0,
        protectedFileFailures: 0,
      },
    },
    results: [
      { id: 'case-one', concept: 'editing', passed: true, protectedFiles: { passed: true } },
      { id: 'case-two', concept: 'safety', passed: true, protectedFiles: { passed: true } },
    ],
    ...overrides,
  }
}

describe('live eval release gate', () => {
  it('accepts a fresh complete report with perfect pass rates', () => {
    const result = validateLiveEvalReport(reportFixture(), manifestFixture(), config, now)

    expect(result).toEqual({ passed: true, failures: [] })
  })

  it('rejects missing case coverage even when the summary looks good', () => {
    const result = validateLiveEvalReport(
      reportFixture({
        results: [
          { id: 'case-one', concept: 'editing', passed: true, protectedFiles: { passed: true } },
        ],
      }),
      manifestFixture(),
      config,
      now,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('missing case results: case-two')
  })

  it('rejects stale results', () => {
    const result = validateLiveEvalReport(
      reportFixture({ generatedAt: '2026-06-01T00:00:00.000Z' }),
      manifestFixture(),
      config,
      now,
    )

    expect(result.passed).toBe(false)
    expect(result.failures.some((failure) => failure.includes('above 72h'))).toBe(true)
  })

  it('rejects runtime errors and protected file tampering', () => {
    const result = validateLiveEvalReport(
      reportFixture({
        summary: {
          ...reportFixture().summary,
          totals: {
            runtimeErrors: 1,
            protectedFileFailures: 1,
          },
        },
        results: [
          {
            id: 'case-one',
            concept: 'editing',
            passed: true,
            protectedFiles: { passed: false, changed: ['tasks/a/a.test.js'] },
          },
          { id: 'case-two', concept: 'safety', passed: true, protectedFiles: { passed: true } },
        ],
      }),
      manifestFixture(),
      config,
      now,
    )

    expect(result.passed).toBe(false)
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'runtime error events must be zero, saw 1',
        'protected file failures must be zero, saw 1',
        'case-one changed protected files: tasks/a/a.test.js',
      ]),
    )
  })
})
