import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, type PingServer, runCli, startCli, startPingServer } from './support/cli.js'

let server: PingServer

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_JOB_UUID: MONITOR_ID,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function node(source: string): string[] {
  return ['--', process.execPath, '-e', source]
}

function ping(index: number): {
  action: string | null
  method: string
  body: string
  headers: Readonly<Record<string, string>>
} {
  const request = server.requests[index]

  if (request === undefined) {
    throw new Error(`no check-in was sent at index ${String(index)}`)
  }

  return {
    action: request.action,
    method: request.method,
    body: request.body,
    headers: request.headers,
  }
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('cronheart run hands back the child’s exit code', () => {
  it.each([0, 1, 3, 42])('reports %i exactly as the child left it', async (code) => {
    const ran = await runCli(['run', '--name=job', ...node(`process.exit(${code})`)], {
      env: envFor(),
    })

    expect({ status: ran.status, signal: ran.signal }).toEqual({ status: code, signal: null })
    expect(server.requests.map((request) => request.action)).toEqual([
      'start',
      code === 0 ? 'success' : 'fail',
    ])
  })

  it('keeps the child’s code when the check-in server answers 500 on every attempt', async () => {
    server.replyWith(() => ({ status: 500, body: 'nope' }))

    const ran = await runCli(['run', '--name=job', ...node('process.exit(7)')], { env: envFor() })

    expect(ran.status).toBe(7)
    expect(server.requests.length).toBeGreaterThan(0)
    expect(ran.stderr).toContain('cronheart:')
  })

  it('keeps the child’s code when nothing is listening at the base URL at all', async () => {
    const ran = await runCli(['run', '--name=job', ...node('process.exit(9)')], {
      env: envFor({ CRONHEART_URL: 'http://127.0.0.1:1' }),
    })

    expect(ran.status).toBe(9)
    expect(ran.stderr).toContain('cronheart:')
  })

  it('runs the command and keeps its code when the monitor name resolves to nothing', async () => {
    const ran = await runCli(['run', '--name=absent', ...node('console.log("RAN"); process.exit(5)')], {
      env: { CRONHEART_URL: server.url },
    })

    expect(ran.status).toBe(5)
    expect(ran.stdout).toContain('RAN')
    expect(server.requests).toHaveLength(0)
    expect(ran.stderr).toContain('cronheart:')
  })

  // Both check-ins have to reach the server and fail there, or one line is what a single
  // check-in would produce as well and the de-duplication under test is never exercised.
  it('writes one line, not one per check-in, when both check-ins fail the same way', async () => {
    server.replyWith(() => ({ status: 500, body: 'nope' }))

    const ran = await runCli(['run', '--name=job', ...node('process.exit(0)')], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.action)).toEqual(['start', 'success'])
    expect(ran.stderr.split('\n').filter((line) => line.startsWith('cronheart:'))).toHaveLength(1)
  })
})

describe('cronheart run check-ins', () => {
  it('opens with a start check-in and closes with success, carrying the measured runtime', async () => {
    const ran = await runCli(['run', '--name=job', ...node('process.exit(0)')], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => `${request.method} ${request.action}`)).toEqual([
      'POST start',
      'POST success',
    ])
    expect(ping(0).headers['x-cronheart-runtime-ms']).toBeUndefined()
    expect(ping(1).headers['x-cronheart-runtime-ms']).toMatch(/^[0-9]+$/)
  })

  it('closes with fail and states the status, never the raw exit segment', async () => {
    const ran = await runCli(['run', '--name=job', ...node('process.exit(3)')], { env: envFor() })

    expect(ran.status).toBe(3)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).action).toBe('fail')
    expect(ping(1).method).toBe('POST')
    expect(ping(1).body).toContain('exited with status 3')
  })

  it('addresses the monitor by id when one is passed rather than a name', async () => {
    const ran = await runCli([`run`, `--uuid=${MONITOR_ID}`, ...node('process.exit(0)')], {
      env: { CRONHEART_URL: server.url, CRONHEART_TIMEOUT_MS: '2000' },
    })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.monitorId)).toEqual([MONITOR_ID, MONITOR_ID])
  })
})

describe('cronheart run tees stderr', () => {
  it('passes the child’s stderr through to the parent and still sends the tail', async () => {
    const ran = await runCli(
      ['run', '--name=job', ...node('process.stderr.write("boom on stderr\\n"); process.exit(4)')],
      { env: envFor() },
    )

    expect(ran.status).toBe(4)
    expect(ran.stderr).toContain('boom on stderr')
    expect(server.requests).toHaveLength(2)
    expect(ping(1).body).toContain('boom on stderr')
  })

  it('leaves the child’s stdout alone', async () => {
    const ran = await runCli(
      ['run', '--name=job', ...node('process.stdout.write("on stdout\\n")')],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('on stdout\n')
  })

  it('sends no body on a successful run', async () => {
    await runCli(['run', '--name=job', ...node('process.stderr.write("chatter\\n")')], {
      env: envFor(),
    })

    expect(server.requests).toHaveLength(2)
    expect(ping(1).action).toBe('success')
    expect(ping(1).body).toBe('')
  })

  it('bounds the tail by bytes and cuts it on a code-point boundary across chunk edges', async () => {
    const source = [
      'const one = Buffer.from("\\u20ac")',
      'const all = Buffer.concat(Array.from({ length: 400 }, () => one))',
      'for (let at = 0; at < all.length; at += 7) process.stderr.write(all.subarray(at, at + 7))',
      'process.exit(9)',
    ].join('; ')
    const ran = await runCli(['run', '--name=job', '--stderr-bytes=100', ...node(source)], {
      env: envFor(),
    })

    expect(ran.status).toBe(9)
    expect(server.requests).toHaveLength(2)

    const body = ping(1).body
    const tail = body.slice(body.indexOf('\n') + 1).trim()

    expect(body).toContain('exited with status 9')
    expect(body).not.toContain('�')
    expect(tail.length).toBeGreaterThan(0)
    expect(tail).toBe('€'.repeat(tail.length))
    expect(new TextEncoder().encode(tail).length).toBeLessThanOrEqual(100)
    expect(new TextEncoder().encode(tail).length).toBeGreaterThan(94)
  })
})

describe('cronheart run deadlines and signals', () => {
  it('kills a child that overruns --timeout and exits 124, matching timeout(1)', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--timeout=400ms', '--kill-after=300ms', ...node('setTimeout(() => {}, 60000)')],
      { env: envFor() },
    )

    expect(ran.status).toBe(124)
    expect(ran.elapsedMs).toBeLessThan(20_000)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).action).toBe('fail')
    expect(ping(1).body).toContain('timed out')
  })

  it('forwards SIGTERM to the child and still reports the code the child chose', async () => {
    const live = startCli(
      ['run', '--name=job', ...node('process.on("SIGTERM", () => process.exit(42)); setInterval(() => {}, 50)')],
      { env: envFor() },
    )

    await new Promise((resolve) => setTimeout(resolve, 600))
    live.child.kill('SIGTERM')

    const ran = await live.settled

    expect(ran.status).toBe(42)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).action).toBe('fail')
    expect(ping(1).body).toContain('SIGTERM')
  })

  it('escalates to SIGKILL when the child ignores the forwarded signal', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        '--kill-after=400ms',
        ...node('process.on("SIGTERM", () => {}); setInterval(() => {}, 50)'),
      ],
      { env: envFor() },
    )

    await new Promise((resolve) => setTimeout(resolve, 600))
    live.child.kill('SIGTERM')

    const ran = await live.settled

    expect(ran.status).toBe(137)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).body).toContain('SIGKILL')
  })

  it('records the escalation, so an alert tells a wrapper kill from an outside one', async () => {
    const live = startCli(
      [
        'run',
        '--name=job',
        '--kill-after=400ms',
        ...node('process.on("SIGTERM", () => {}); setInterval(() => {}, 50)'),
      ],
      { env: envFor() },
    )

    await new Promise((resolve) => setTimeout(resolve, 600))
    live.child.kill('SIGTERM')

    const ran = await live.settled

    expect(ran.status).toBe(137)
    expect(ping(1).body).toContain('escalated to SIGKILL')
  })

  it('records it after --timeout too, where the summary names no signal at all', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--timeout=300ms',
        '--kill-after=300ms',
        ...node('process.on("SIGTERM", () => {}); setInterval(() => {}, 50)'),
      ],
      { env: envFor() },
    )

    expect(ran.status).toBe(124)
    expect(ping(1).body).toContain('timed out')
    expect(ping(1).body).toContain('escalated to SIGKILL')
  })

  it('synthesises 128 + signum when the child dies by a signal nobody forwarded', async () => {
    const ran = await runCli(
      ['run', '--name=job', ...node('process.kill(process.pid, "SIGKILL")')],
      { env: envFor() },
    )

    expect(ran.status).toBe(137)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).body).toContain('SIGKILL')
    expect(ping(1).body).toContain('137')
    expect(ping(1).body).not.toContain('escalated')
  })
})

describe('cronheart run usage errors', () => {
  it.each([
    ['no command after the separator', ['run', '--name=job', '--']],
    ['no separator at all', ['run', '--name=job', 'echo', 'hi']],
    ['no monitor', ['run', '--', 'true']],
    ['an unknown flag', ['run', '--name=job', '--nope=1', '--', 'true']],
    ['a timeout that is not a duration', ['run', '--name=job', '--timeout=soon', '--', 'true']],
    ['a zero timeout', ['run', '--name=job', '--timeout=0', '--', 'true']],
    ['a stderr budget past the body cap', ['run', '--name=job', '--stderr-bytes=99999', '--', 'true']],
    ['a value-less flag that needs one', ['run', '--name', '--', 'true']],
  ])('exits 64 on %s, without spawning anything', async (_why, args) => {
    const ran = await runCli(args, { env: envFor() })

    expect(ran.status).toBe(64)
    expect(server.requests).toHaveLength(0)
    expect(ran.stderr).toContain('cronheart:')
  })

  it('spawns nothing at all on a usage error, proven by the command it refused to run', async () => {
    const ran = await runCli(
      ['run', '--nope', ...node('process.stdout.write("SHOULD-NOT-RUN")')],
      { env: envFor() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stdout).not.toContain('SHOULD-NOT-RUN')
  })

  it('reports 127 when the command does not exist, and says so in the check-in', async () => {
    const ran = await runCli(['run', '--name=job', '--', 'a-command-that-does-not-exist'], {
      env: envFor(),
    })

    expect(ran.status).toBe(127)
    expect(server.requests).toHaveLength(2)
    expect(ping(1).action).toBe('fail')
    expect(ping(1).body).toContain('ENOENT')
  })
})

describe('cronheart run process lifetime', () => {
  it('exits as soon as the check-ins settle rather than lingering on a pooled socket', async () => {
    const ran = await runCli(['run', '--name=job', ...node('process.exit(0)')], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests).toHaveLength(2)
    expect(ran.elapsedMs).toBeLessThan(1200)
  })

  // 10 s would pass in exactly the world this forbids. The budget here is one 500 ms check-in
  // that is never answered, so anything past a second means the stall was waited out.
  it('does not wait out a stalled check-in beyond the configured budget', async () => {
    server.replyWith(() => ({ delayMs: 5000 }))

    const ran = await runCli(['run', '--name=job', ...node('process.exit(2)')], {
      env: envFor({ CRONHEART_TIMEOUT_MS: '500' }),
    })

    expect(ran.status).toBe(2)
    expect(ran.elapsedMs).toBeLessThan(1500)
  })
})
