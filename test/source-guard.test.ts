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
  return [...output.matchAll(/ {2}- ([a-z-]+): (\S+?):[0-9]+ —/g)]
    .map(([, rule, file]) => `${String(rule)} ${String(file)}`)
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

  it('catches the banned expressions on the ping path, a second retry loop deriving its own attempt count, a transport reaching into wiring, the ping path reaching into the management client, and an expression hidden in an interpolation', () => {
    const run = guard('test/fixtures/source-guard/dirty')

    expect(run.status).toBe(1)
    expect(rulesIn(run.output)).toEqual([
      'attempt-count-derived-outside-the-bound ping/hot.ts',
      'fetch-outside-transport ping/hot.ts',
      'fetch-outside-transport ping/hot.ts',
      'ping-path-imports-the-management-client ping/dynamic.ts',
      'ping-path-imports-the-management-client ping/hot.ts',
      'ping-path-imports-the-management-client ping/quoted.ts',
      'ping-path-imports-the-management-client ping/relay.ts',
      'ping-path-imports-the-management-client ping/required.ts',
      'ping-path-imports-the-management-client ping/side-effect.ts',
      'ping-path-reaches-the-management-client ping/warm.ts',
      'promise-reject-outside-guarded-layer ping/hot.ts',
      'throw-outside-guarded-layer ping/hot.ts',
      'transport-imports-wiring transport/net.ts',
    ])
  })

  it('names the route when the management client is reached through another module', () => {
    const run = guard('test/fixtures/source-guard/dirty')

    expect(run.output).toContain('ping/warm.ts → ping/relay.ts → api/manage.ts')
  })
})
