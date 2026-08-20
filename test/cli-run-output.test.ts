import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

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

function failBody(): string {
  const request = server.requests.find((one) => one.action === 'fail')

  if (request === undefined) {
    throw new Error('no fail check-in was sent')
  }

  return request.body
}

function excerptOf(body: string): string {
  const at = body.indexOf('\n')

  return at === -1 ? '' : body.slice(at).trim()
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('the excerpt covers everything the command said, not only its stderr', () => {
  it('carries a failure the command reported on stdout', async () => {
    const ran = await runCli(
      ['run', '--name=job', ...node('console.log("Traceback: no such table"); process.exit(1)')],
      { env: envFor() },
    )

    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('Traceback: no such table')
    expect(failBody()).toContain('Traceback: no such table')
  })

  it('carries both streams when the command uses both', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        ...node('console.log("on stdout"); console.error("on stderr"); process.exit(2)'),
      ],
      { env: envFor() },
    )

    expect(ran.status).toBe(2)
    expect(failBody()).toContain('on stdout')
    expect(failBody()).toContain('on stderr')
  })

  it('still passes both streams through to the caller unchanged', async () => {
    const ran = await runCli(
      ['run', '--name=job', ...node('console.log("out"); console.error("err")')],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('out\n')
    expect(ran.stderr).toBe('err\n')
  })
})

describe('the flag that bounds the excerpt', () => {
  // The shape is asserted as well as the size: an excerpt that never arrived leaves the body
  // holding the summary alone, which is under any budget and would satisfy a bound on its own.
  it('bounds what the command wrote on stdout under --output-bytes', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--output-bytes=60', ...node('console.log("o".repeat(400)); process.exit(1)')],
      { env: envFor() },
    )
    const excerpt = excerptOf(failBody())

    expect(ran.status).toBe(1)
    expect(excerpt).toMatch(/^o+$/)
    expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(60)
  })

  it('keeps --stderr-bytes working for a crontab already written against it', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--stderr-bytes=60', ...node('console.error("e".repeat(400)); process.exit(1)')],
      { env: envFor() },
    )
    const excerpt = excerptOf(failBody())

    expect(ran.status).toBe(1)
    expect(excerpt).toMatch(/^e+$/)
    expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(60)
  })

  it('inserts no pipe on either stream at --output-bytes=0, so both stay the caller’s own', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--output-bytes=0',
        ...node(
          'console.log("BOTH-STREAMS-STILL-ARRIVE"); console.error("chatter"); process.exit(1)',
        ),
      ],
      { env: envFor() },
    )

    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('BOTH-STREAMS-STILL-ARRIVE')
    expect(failBody()).toBe('exited with status 1')
  })
})
