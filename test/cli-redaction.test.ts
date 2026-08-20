import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_STDERR_TAIL_BYTES } from '../src/cli/run.js'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

let server: PingServer

const KEY_TAIL = 'A1B2C3D4E5F6G7H8J9K0LMNPQRSTUVWXYZabcde'

const KEY = `cmk_${KEY_TAIL}`

const BEARER_TAIL = 'not-a-real-token.not-a-real-token.not-a-real-signature-0000'

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_JOB_UUID: MONITOR_ID,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

// The child writes its own stderr rather than being handed a string on the command line:
// the reproduction turns on where the byte budget falls, and an argv round trip through a
// shell would re-wrap the payload. The filler opens with a newline and is written in dots
// because every built-in pattern is greedy — letters or dots pressed straight against the
// secret would be swallowed into the same match and the excerpt would prove nothing.
function emits(before: string, secret: string, after: number): string[] {
  return [
    '--',
    process.execPath,
    '-e',
    `process.stderr.write(${JSON.stringify(before)} + ${JSON.stringify(secret)} + "\\n" + ".".repeat(${after - 1})); process.exit(3)`,
  ]
}

function failBody(): string {
  const request = server.requests.find((one) => one.action === 'fail')

  return request === undefined ? '<no fail check-in was sent>' : request.body
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('what cronheart run puts on the wire when the child prints a secret', () => {
  it('redacts a token the child wrote, with no flags and no configuration at all', async () => {
    const ran = await runCli(['run', '--name=job', ...emits('failed: ', KEY, 10)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain(KEY_TAIL)
  })

  it('redacts the password embedded in a connection string', async () => {
    const secret = 'postgres://appuser:hunter2-not-a-real-password@db.invalid:5432/app'
    const ran = await runCli(['run', '--name=job', ...emits('cannot connect to ', secret, 10)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain('hunter2-not-a-real-password')
  })

  it('redacts a credential assigned to an environment-shaped name', async () => {
    const secret = 'AWS_SECRET_ACCESS_KEY=not-a-real-secret-000000000000000000000'
    const ran = await runCli(['run', '--name=job', ...emits('config dump: ', secret, 10)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain('not-a-real-secret-000000000000000000000')
  })

  it('redacts a Basic credential without hiding which scheme was used', async () => {
    const secret = 'Authorization: Basic bm90LWEtcmVhbC1jcmVkZW50aWFsLTAwMDA='
    const ran = await runCli(['run', '--name=job', ...emits('rejected ', secret, 10)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('Basic [redacted]')
    expect(failBody()).not.toContain('bm90LWEtcmVhbC1jcmVkZW50aWFsLTAwMDA=')
  })
})

// The window is the last MAX_STDERR_TAIL_BYTES bytes of stderr, so a secret placed this far
// from the end is cut by the wrapper's own budget — the anchor every built-in pattern keys
// on lands outside the excerpt while the secret material stays inside it.
describe('a secret straddling the wrapper’s own stderr budget', () => {
  it.each([
    ['at the prefix, so the anchor is the part cut away', 4],
    ['one byte into the token', 1],
    ['exactly at the first byte of the token', 0],
    ['midway through the token', 20],
  ])('is still redacted when the cut falls %s', async (_where, into) => {
    const after = MAX_STDERR_TAIL_BYTES - (KEY.length - into)
    const ran = await runCli(['run', '--name=job', ...emits('head '.repeat(40), KEY, after)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody().length).toBeGreaterThan(1000)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain(KEY.slice(into))
    expect(failBody()).not.toContain(KEY_TAIL.slice(-20))
  })

  it('is still redacted when a Bearer header is cut after the scheme word', async () => {
    const header = `Authorization: Bearer ${BEARER_TAIL}`
    const after = MAX_STDERR_TAIL_BYTES - BEARER_TAIL.length
    const ran = await runCli(['run', '--name=job', ...emits('head '.repeat(40), header, after)], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(failBody().length).toBeGreaterThan(1000)
    expect(failBody()).toContain('Bearer [redacted]')
    expect(failBody()).not.toContain(BEARER_TAIL)
    expect(failBody()).not.toContain(BEARER_TAIL.slice(-24))
  })
})

describe('the redaction patterns a caller adds', () => {
  it('takes a pattern from --redact and applies it to the excerpt', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--redact=INTERNAL-[0-9]{6}', ...emits('trace ', 'INTERNAL-424242', 10)],
      { env: envFor() },
    )

    expect(ran.status).toBe(3)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain('INTERNAL-424242')
  })

  it('takes every --redact it is given rather than only the last one', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--redact=ALPHA-[0-9]+',
        '--redact=BETA-[0-9]+',
        ...emits('trace ', 'ALPHA-111 and BETA-222', 10),
      ],
      { env: envFor() },
    )

    expect(ran.status).toBe(3)
    expect(failBody()).not.toContain('ALPHA-111')
    expect(failBody()).not.toContain('BETA-222')
  })

  it('takes patterns from the environment for a crontab that cannot pass flags', async () => {
    const ran = await runCli(['run', '--name=job', ...emits('trace ', 'GAMMA-333', 10)], {
      env: envFor({ CRONHEART_REDACT: 'GAMMA-[0-9]+' }),
    })

    expect(ran.status).toBe(3)
    expect(failBody()).not.toContain('GAMMA-333')
  })

  it('applies a pattern given to ping as well, because a body is passed in the same way', async () => {
    const ran = await runCli(
      ['ping', 'job', '--action=fail', '--redact=DELTA-[0-9]+', '--body=trace DELTA-444'],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(failBody()).toContain('[redacted]')
    expect(failBody()).not.toContain('DELTA-444')
  })

  // Named in the message, and named as a pattern: exit 64 with a cronheart: prefix is what
  // every usage error produces, an unknown flag included, so asserting only that would pass
  // just as well on a build where --redact does not exist.
  it('refuses a pattern that is not a regular expression, before anything is spawned', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--redact=(unclosed', ...emits('x', 'y', 1)],
      { env: envFor() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--redact is not a regular expression')
    expect(ran.stderr).toContain('(unclosed')
    expect(server.requests).toHaveLength(0)
  })

  it('refuses an unusable pattern in the environment rather than protecting nothing quietly', async () => {
    const ran = await runCli(['run', '--name=job', ...emits('x', 'y', 1)], {
      env: envFor({ CRONHEART_REDACT: '[unclosed' }),
    })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('CRONHEART_REDACT is not a regular expression')
    expect(server.requests).toHaveLength(0)
  })
})

describe('the total opt-out', () => {
  it('sends no excerpt at all under --stderr-bytes=0, only the summary', async () => {
    const ran = await runCli(
      ['run', '--name=job', '--stderr-bytes=0', ...emits('secret line ', KEY, 10)],
      { env: envFor() },
    )

    expect(ran.status).toBe(3)
    expect(failBody()).toBe('exited with status 3')
    expect(ran.stderr).toContain(KEY)
  })
})

describe('the wrapped command’s environment', () => {
  it('does not hand the account-wide API key to the command it wraps', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--',
        process.execPath,
        '-e',
        'process.stdout.write("KEY=[" + (process.env.CRONHEART_API_KEY ?? "") + "]")',
      ],
      { env: envFor({ CRONHEART_API_KEY: 'cmk_notarealkey0000' }) },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe('KEY=[]')
  })

  it('still hands the command the rest of the environment it was started with', async () => {
    const ran = await runCli(
      [
        'run',
        '--name=job',
        '--',
        process.execPath,
        '-e',
        'process.stdout.write("URL=[" + (process.env.CRONHEART_URL ?? "") + "]")',
      ],
      { env: envFor({ CRONHEART_API_KEY: 'cmk_notarealkey0000' }) },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`URL=[${server.url}]`)
  })
})
