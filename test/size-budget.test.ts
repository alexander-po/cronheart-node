import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)

const REPORTED =
  /ping entry \((\d+) module\(s\)\) — (\d+) B minified\+gzipped \(budget (\d+) B\), (\d+) B gzipped unminified — (ok|OVER BUDGET)/

const CEILING_IN_README = /CI fails on a regression past ([\d,]+) bytes/

interface Measurement {
  readonly modules: number
  readonly minified: number
  readonly budget: number
  readonly unminified: number
  readonly verdict: string
  readonly status: number | null
}

let measured: Measurement | undefined

function measure(): Measurement {
  if (measured === undefined) {
    const run = spawnSync(process.execPath, ['scripts/size-budget.mjs'], {
      cwd: fileURLToPath(root),
      encoding: 'utf8',
    })
    const reported = REPORTED.exec(run.stdout)

    if (reported === null) {
      throw new Error(`the size budget reported no minified figure: ${run.stdout}${run.stderr}`)
    }

    measured = {
      modules: Number(reported[1]),
      minified: Number(reported[2]),
      budget: Number(reported[3]),
      unminified: Number(reported[4]),
      verdict: String(reported[5]),
      status: run.status,
    }
  }

  return measured
}

describe('the size budget is measured on what a consumer downloads', () => {
  it(
    'reports the minified figure alongside the unminified one it used to bound',
    () => {
      const { modules, minified, unminified } = measure()

      expect(modules).toBeGreaterThan(0)
      expect(minified).toBeLessThan(unminified)
    },
    120_000,
  )

  it('holds the entry to a ceiling on the minified figure', () => {
    const { minified, budget, verdict, status } = measure()

    expect(budget).toBe(7168)
    expect(minified).toBeLessThanOrEqual(budget)
    expect(verdict).toBe('ok')
    expect(status).toBe(0)
  })

  it('quotes that same ceiling in the README, so the documented number cannot drift', () => {
    const readme = readFileSync(new URL('README.md', root), 'utf8')
    const quoted = CEILING_IN_README.exec(readme)

    if (quoted === null) {
      throw new Error('the README quotes no ceiling for the size budget')
    }

    expect(Number(String(quoted[1]).replaceAll(',', ''))).toBe(measure().budget)
  })
})
