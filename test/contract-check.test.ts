import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)

interface Run {
  readonly status: number
  readonly output: string
}

function check(...args: string[]): Run {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, ['contract/check.mjs', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    }
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string }

    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` }
  }
}

describe('the contract check', () => {
  it('passes the shipped contract against the built SDK', () => {
    const run = check()

    expect(run.status).toBe(0)
    expect(run.output).toContain('ok')
  })

  it('fails on a wire literal the SDK holds and no anchor states', () => {
    const run = check(
      'contract/cronheart-contract.json',
      'test/fixtures/contract/sdk-with-an-unanchored-literal.mjs',
    )

    expect(run.status).toBe(1)
    expect(run.output).toContain('A_LITERAL_NOBODY_ANCHORED')
    expect(run.output).toContain('not recorded as unanchored')
  })

  it('fails on a ledger entry that no longer names an anchor', () => {
    const run = check(
      'test/fixtures/contract/contract-with-one-unheld-anchor.json',
      'dist/index.mjs',
    )

    expect(run.status).toBe(1)
    expect(run.output).toContain('recorded in a ledger but the contract has no anchor by that name')
    expect(run.output).toContain('fixture.value')
  })
})
