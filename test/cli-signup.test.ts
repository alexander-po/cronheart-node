import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type PingRequest,
  type PingServer,
  type Ran,
  type RunOptions,
  type ServerReply,
  runCli as runTheCli,
  startPingServer,
} from './support/cli.js'

const DEVICE_CODE = 'device-code-held-by-this-terminal-alone'

const TOKEN = `cmk_${'7'.repeat(28)}synthetic`

const ADDRESS = 'someone@example.com'

const START_PATH = '/api/v1/signup'

const POLL_PATH = '/api/v1/signup/token'

let server: PingServer
let workspace: string
let ran: Ran[] = []
let keyOnStdout = false

// Every run is read for the two secrets afterwards, failure paths included: the device code
// never reaches either stream, and the key reaches stdout only where a case says it may.
async function runCli(args: readonly string[], options: RunOptions = {}): Promise<Ran> {
  const result = await runTheCli(args, options)

  ran.push(result)

  return result
}

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): ServerReply {
  return {
    status,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  }
}

function started(overrides: Readonly<Record<string, unknown>> = {}): ServerReply {
  return json(202, {
    device_code: DEVICE_CODE,
    user_code: 'BCDF-GHJK',
    expires_in: 1800,
    interval: 1,
    hint: 'A hint for the caller.',
    ...overrides,
  })
}

const PENDING = json(202, { status: 'authorization_pending' })

const ISSUED = json(200, { token: TOKEN, token_prefix: 'cmk_7777', project: 'default' })

// Answers the start once and then each poll with the next reply in line, repeating the last,
// and stamps every request so the spacing between polls can be read back.
function scripted(start: ServerReply, polls: readonly ServerReply[], onPoll?: (index: number) => void): number[] {
  const stamps: number[] = []
  let polled = 0

  server.replyWith((request: PingRequest) => {
    stamps.push(Date.now())

    if (request.path === START_PATH) {
      return start
    }

    if (request.path === POLL_PATH) {
      onPoll?.(polled)
      polled += 1

      return polls[Math.min(polled - 1, polls.length - 1)] ?? PENDING
    }

    return { status: 404, body: '' }
  })

  return stamps
}

function envFile(): string {
  return join(workspace, '.env')
}

function env(): Record<string, string> {
  return { CRONHEART_URL: server.url, CRONHEART_TIMEOUT_MS: '2000' }
}

function signup(...extra: string[]) {
  return runCli(['signup', ADDRESS, '--accept-terms', `--env-path=${envFile()}`, ...extra], {
    env: env(),
    cwd: workspace,
  })
}

function paths(): string[] {
  return server.requests.map((request) => request.path)
}

beforeEach(async () => {
  server = await startPingServer()
  workspace = mkdtempSync(join(tmpdir(), 'cronheart-signup-'))
  ran = []
  keyOnStdout = false
})

afterEach(async () => {
  await server.close()
  chmodSync(workspace, 0o700)
  rmSync(workspace, { recursive: true, force: true })

  for (const result of ran) {
    expect(`${result.stdout}${result.stderr}`).not.toContain(DEVICE_CODE)
    expect(result.stderr).not.toContain(TOKEN)

    if (!keyOnStdout) {
      expect(result.stdout).not.toContain(TOKEN)
    }
  }
})

describe('cronheart signup refuses before anything is asked of the service', () => {
  it('names a flag it does not take', async () => {
    const ran = await runCli(['signup', ADDRESS, '--accept-terms', '--yes'], { env: env() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('signup does not take --yes')
    expect(paths()).toEqual([])
  })

  it.each([[[]], [[ADDRESS, 'other@example.com']]])('wants exactly one address (%j)', async (given) => {
    const ran = await runCli(['signup', ...given, '--accept-terms'], { env: env() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('one email address')
    expect(paths()).toEqual([])
  })

  it('names the terms and the privacy policy of the service it would talk to, and stops', async () => {
    const ran = await runCli(['signup', ADDRESS], { env: env() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain(`${server.url}/terms`)
    expect(ran.stderr).toContain(`${server.url}/privacy`)
    expect(ran.stderr).toContain('--accept-terms')
    expect(paths()).toEqual([])
  })

  it('refuses an address the client can already tell is not one', async () => {
    const ran = await runCli(['signup', 'someone.example.com', '--accept-terms', '--print-env'], {
      env: env(),
    })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('email must be one address')
    expect(paths()).toEqual([])
  })

  it.each([
    'CRONHEART_API_KEY=cmk_replace-me\n',
    'export CRONHEART_API_KEY=cmk_replace-me\n',
    'OTHER=1\n  CRONHEART_API_KEY=cmk_replace-me\n',
  ])('refuses an env file that already holds a key, rather than overwrite it after the fact (%j)', async (held) => {
    writeFileSync(envFile(), held, { mode: 0o600 })

    const ran = await signup()

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('already assigns CRONHEART_API_KEY')
    expect(readFileSync(envFile(), 'utf8')).toBe(held)
    expect(paths()).toEqual([])
  })

  it('refuses an env file others can read, since the key would keep that mode', async () => {
    writeFileSync(envFile(), 'OTHER=1\n')
    chmodSync(envFile(), 0o644)

    const ran = await signup()

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('can be read or written by others (mode 644)')
    expect(paths()).toEqual([])
  })

  it('refuses an env file that is a link before anything is asked of the service', async () => {
    const elsewhere = join(workspace, 'elsewhere')

    writeFileSync(elsewhere, '', { mode: 0o600 })
    symlinkSync(elsewhere, envFile())

    const ran = await signup()

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('symbolic link')
    expect(paths()).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('refuses a directory it could not write the key into', async () => {
    chmodSync(workspace, 0o500)

    const ran = await signup()

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('is not writable')
    expect(paths()).toEqual([])
  })

  it('refuses an env file in a directory that does not exist', async () => {
    const ran = await runCli(
      ['signup', ADDRESS, '--accept-terms', `--env-path=${join(workspace, 'missing', '.env')}`],
      { env: env() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('does not exist')
    expect(paths()).toEqual([])
  })
})

describe('cronheart signup through to the key', () => {
  it('shows the code, polls at the interval, and writes the key to a file only its owner reads', async () => {
    const stamps = scripted(started({ interval: 2 }), [PENDING, ISSUED])
    const ran = await runCli(['signup', ADDRESS, '--accept-terms', `--env-path=${envFile()}`], {
      env: { ...env(), CRONHEART_API_KEY: 'cmk_replace-me' },
    })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('BCDF-GHJK')
    expect(ran.stdout).toContain('wrote CRONHEART_API_KEY (cmk_7777…)')
    expect(readFileSync(envFile(), 'utf8')).toBe(`CRONHEART_API_KEY=${TOKEN}\n`)
    expect((statSync(envFile()).mode & 0o777).toString(8)).toBe('600')
    expect(paths()).toEqual([START_PATH, POLL_PATH, POLL_PATH])
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ email: ADDRESS, accept_terms: true })
    expect(server.requests.map((request) => request.headers['authorization'])).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(JSON.parse(server.requests[1]?.body ?? '')).toEqual({ device_code: DEVICE_CODE })
    expect(Number(stamps[1]) - Number(stamps[0])).toBeGreaterThanOrEqual(1950)
    expect(Number(stamps[2]) - Number(stamps[1])).toBeGreaterThanOrEqual(1950)
  })

  it('never polls faster than once a second, whatever interval the service names', async () => {
    const stamps = scripted(started({ interval: 0 }), [PENDING, ISSUED])
    const ran = await signup()

    expect(ran.status).toBe(0)
    expect(Number(stamps[1]) - Number(stamps[0])).toBeGreaterThanOrEqual(950)
    expect(Number(stamps[2]) - Number(stamps[1])).toBeGreaterThanOrEqual(950)
  })

  it('writes to .env in the working directory when no path is named', async () => {
    scripted(started(), [ISSUED])

    const ran = await runCli(['signup', ADDRESS, '--accept-terms'], { env: env(), cwd: workspace })

    expect(ran.status).toBe(0)
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe(`CRONHEART_API_KEY=${TOKEN}\n`)
  })

  it.each([
    ['one the size of the whole key', TOKEN],
    ['one the key does not start with', 'cmk_0000'],
  ])('shows no prefix the service sends that is %s', async (_label, prefix) => {
    scripted(started(), [json(200, { token: TOKEN, token_prefix: prefix, project: 'default' })])

    const ran = await signup()

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('wrote CRONHEART_API_KEY (the key)')
  })

  it('adds the key to an existing env file and leaves the rest of it alone', async () => {
    writeFileSync(envFile(), 'DATABASE_URL=postgres://localhost/app\n', { mode: 0o600 })
    scripted(started(), [ISSUED])

    const ran = await signup()

    expect(ran.status).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(
      `DATABASE_URL=postgres://localhost/app\nCRONHEART_API_KEY=${TOKEN}\n`,
    )
    expect((statSync(envFile()).mode & 0o777).toString(8)).toBe('600')
  })

  it('under --print-env writes the assignment alone on stdout and no file', async () => {
    keyOnStdout = true
    scripted(started(), [ISSUED])

    const ran = await signup('--print-env')

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`CRONHEART_API_KEY=${TOKEN}\n`)
    expect(ran.stderr).toContain('BCDF-GHJK')
    expect(existsSync(envFile())).toBe(false)
  })

  it('under --print-env leaves an env file that already holds a key alone', async () => {
    keyOnStdout = true
    writeFileSync(envFile(), 'CRONHEART_API_KEY=cmk_replace-me\n', { mode: 0o600 })
    scripted(started(), [ISSUED])

    const ran = await signup('--print-env')

    expect(ran.status).toBe(0)
    expect(ran.stdout).toBe(`CRONHEART_API_KEY=${TOKEN}\n`)
    expect(readFileSync(envFile(), 'utf8')).toBe('CRONHEART_API_KEY=cmk_replace-me\n')
  })

  it('waits as long as a 429 says before polling again, then goes back to the interval', async () => {
    const stamps = scripted(started(), [
      json(429, { status: 429, error: 'slow_down' }, { 'Retry-After': '2' }),
      PENDING,
      ISSUED,
    ])
    const ran = await signup()

    expect(ran.status).toBe(0)
    expect(Number(stamps[2]) - Number(stamps[1])).toBeGreaterThanOrEqual(1950)
    expect(Number(stamps[3]) - Number(stamps[2])).toBeLessThan(1900)
  })

  it.each([
    ['a 503', json(503, { status: 503 })],
    ['a poll that outlives its time budget', { ...PENDING, delayMs: 3000 }],
  ])('keeps polling through %s, and says so', async (_label, unanswered) => {
    scripted(started(), [unanswered, ISSUED])

    const ran = await signup()

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('a poll went unanswered')
    expect(readFileSync(envFile(), 'utf8')).toBe(`CRONHEART_API_KEY=${TOKEN}\n`)
  })

  it('hands the key over on stdout when the file cannot take it after the confirmation', async () => {
    keyOnStdout = true
    const elsewhere = join(workspace, 'elsewhere')

    writeFileSync(elsewhere, '')
    scripted(started(), [ISSUED], () => {
      symlinkSync(elsewhere, envFile())
    })

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('symbolic link')
    expect(ran.stderr).toContain('store it now')
    expect(ran.stdout).toContain(`CRONHEART_API_KEY=${TOKEN}\n`)
    expect(readFileSync(elsewhere, 'utf8')).toBe('')
  })
})

describe('cronheart signup when the file changed during the wait', () => {
  it.each([
    [
      'others can now read it',
      () => {
        chmodSync(envFile(), 0o644)
      },
      'can be read or written by others',
      'OTHER=1\n',
    ],
    [
      'it now holds a key',
      () => {
        writeFileSync(envFile(), 'OTHER=1\nCRONHEART_API_KEY=cmk_replace-me\n')
      },
      'already assigns CRONHEART_API_KEY',
      'OTHER=1\nCRONHEART_API_KEY=cmk_replace-me\n',
    ],
  ])('hands the key over on stdout rather than write it when %s', async (_label, change, said, left) => {
    keyOnStdout = true
    writeFileSync(envFile(), 'OTHER=1\n', { mode: 0o600 })
    scripted(started(), [ISSUED], change)

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain(said)
    expect(ran.stdout).toContain(`CRONHEART_API_KEY=${TOKEN}\n`)
    expect(readFileSync(envFile(), 'utf8')).toBe(left)
  })
})

describe('cronheart signup when the flow does not end in a key', () => {
  it('stops on a signup that is no longer open and says how to start again', async () => {
    scripted(started(), [PENDING, json(410, { status: 410, error: 'expired_token' })])

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('start a new signup')
    expect(existsSync(envFile())).toBe(false)
  })

  it('gives up by itself once the code has expired', async () => {
    scripted(started({ expires_in: 2 }), [PENDING])

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('lifetime ran out before a key was handed over')
    expect(ran.stderr).toContain('Forgot password')
    expect(existsSync(envFile())).toBe(false)
  })

  it.each([
    ['signup switched off', json(403, { status: 403, error: 'signup_disabled' }), 'switched off'],
    ['too many signups', json(429, { status: 429, error: 'rate_limited' }, { 'Retry-After': '60' }), 'Retry after 60 s'],
    ['an address the service refuses', json(422, { status: 422, errors: { email: 'This value is not a valid email address.' } }), 'HTTP 422'],
  ])('exits 1 on %s at the start, and polls nothing', async (_label, reply, said) => {
    scripted(reply, [])

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain(said)
    expect(paths()).toEqual([START_PATH])
  })

  it('refuses to print a code outside the published shape', async () => {
    scripted(started({ user_code: '\u001b[2JBCDF-GHJK' }), [ISSUED])

    const ran = await signup()

    expect(ran.status).toBe(1)
    expect(ran.stdout).not.toContain('\u001b')
    expect(ran.stderr).not.toContain('\u001b')
    expect(paths()).toEqual([START_PATH])
  })
})

describe('cronheart signup --help', () => {
  it('describes signup, its flags and its exit statuses', async () => {
    const ran = await runCli(['signup', '--help'])

    expect(ran.status).toBe(0)

    for (const flag of ['--accept-terms', '--env-path', '--print-env']) {
      expect(ran.stdout).toContain(flag)
    }

    expect(ran.stdout).toContain('Exits 0 once')
  })
})
