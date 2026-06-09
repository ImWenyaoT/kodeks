import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, requestHeaders } from './run-live-evals.mjs'

const currentDir = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(currentDir, '..', '..', 'evals', 'live-coding-tasks.json')

/**
 * Load the live eval manifest used by the runner.
 */
function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

describe('live coding eval manifest', () => {
  it('contains a 50-100 case reliability suite with unique ids', () => {
    const manifest = loadManifest()
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.cases.length).toBeGreaterThanOrEqual(50)
    expect(manifest.cases.length).toBeLessThanOrEqual(100)
    expect(new Set(manifest.cases.map((testCase) => testCase.id)).size).toBe(
      manifest.cases.length,
    )
  })

  it('keeps every verifier as a plain argv command scoped to its workdir', () => {
    const manifest = loadManifest()
    for (const testCase of manifest.cases) {
      expect(testCase.workdir).toMatch(/^tasks\//)
      expect(Object.keys(testCase.files)).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^${testCase.workdir}/`))]),
      )
      expect(testCase.verify.command).toBe('node')
      expect(testCase.verify.args).toEqual([expect.stringMatching(/\.test\.js$/)])
    }
  })

  it('protects each verifier file from model edits', () => {
    const manifest = loadManifest()
    for (const testCase of manifest.cases) {
      const verifierPath = `${testCase.workdir}/${testCase.verify.args[0]}`
      const protectedFiles = testCase.protectedFiles || Object.keys(testCase.files)
      expect(protectedFiles).toEqual(expect.arrayContaining([verifierPath]))
    }
  })
})

describe('live eval control token', () => {
  it('omits authorization headers by default', () => {
    const config = parseArgs([], {})

    expect(requestHeaders(config)).toEqual({ 'Content-Type': 'application/json' })
  })

  it('reads the protected control token from the environment', () => {
    const config = parseArgs([], { KODEKS_CONTROL_TOKEN: 'env-token' })

    expect(requestHeaders(config)).toMatchObject({
      Authorization: 'Bearer env-token',
    })
  })

  it('lets --control-token override environment defaults', () => {
    const config = parseArgs(['--control-token', 'cli-token'], {
      KODEKS_CONTROL_TOKEN: 'env-token',
    })

    expect(requestHeaders(config)).toMatchObject({
      Authorization: 'Bearer cli-token',
    })
  })
})
