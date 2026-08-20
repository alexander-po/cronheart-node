import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

interface Run {
  readonly status: number
  readonly output: string
}

function guard(target: string): Run {
  try {
    return {
      status: 0,
      output: execFileSync(
        process.execPath,
        ['scripts/source-guard.mjs', target],
        { cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    }
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string }

    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` }
  }
}

function rulesIn(output: string): string[] {
  return [...output.matchAll(/ {2}- ([a-z-]+): (\S+) —/g)]
    .map(([, rule, where]) => `${String(rule)} ${String(where)}`)
    .sort()
}

describe('the source guard', () => {
  it('passes the shipped source', () => {
    const run = guard('src')

    expect(run.status).toBe(0)
    expect(run.output).toContain('clean')
  })

  it('ignores the words when they sit in a comment or a string', () => {
    const run = guard('test/fixtures/source-guard/clean')

    expect(run.status).toBe(0)
  })

  it('catches a network call and a throw on the ping path, and a transport reaching into wiring', () => {
    const run = guard('test/fixtures/source-guard/dirty')

    expect(run.status).toBe(1)
    expect(rulesIn(run.output)).toEqual([
      'fetch-outside-transport ping/hot.ts:2',
      'throw-outside-guarded-layer ping/hot.ts:5',
      'transport-imports-wiring transport/net.ts:1',
    ])
  })
})
