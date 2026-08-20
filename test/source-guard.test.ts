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

  it('ignores the words when they sit in a comment or a string, nested ones included', () => {
    const run = guard('test/fixtures/source-guard/clean')

    expect(run.status).toBe(0)
  })

  it('catches the banned expressions on the ping path, a transport reaching into wiring, and an expression hidden in an interpolation', () => {
    const run = guard('test/fixtures/source-guard/dirty')

    expect(run.status).toBe(1)
    expect(rulesIn(run.output)).toEqual([
      'fetch-outside-transport ping/hot.ts:10',
      'fetch-outside-transport ping/hot.ts:2',
      'promise-reject-outside-guarded-layer ping/hot.ts:14',
      'throw-outside-guarded-layer ping/hot.ts:5',
      'transport-imports-wiring transport/net.ts:1',
    ])
  })
})
