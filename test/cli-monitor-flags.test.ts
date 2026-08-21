import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

const NEARLY_AN_ID = '00000000-0000-4000-8000-00000000c11'

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

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('--uuid takes an id and says so when it is handed something else', () => {
  it('refuses a name behind --uuid rather than resolving it as one', async () => {
    const ran = await runCli(['run', '--uuid=job', ...node('process.exit(3)')], { env: envFor() })

    expect(ran.status).toBe(3)
    expect(ran.stderr).toContain('--uuid')
    expect(ran.stderr).toContain('--name')
    expect(server.requests).toHaveLength(0)
  })

  it('shows a mistyped id back and states the shape it failed to match', async () => {
    const ran = await runCli([`run`, `--uuid=${NEARLY_AN_ID}`, ...node('process.exit(3)')], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(ran.stderr).toContain(NEARLY_AN_ID)
    expect(ran.stderr).toContain('36')
    expect(ran.stderr).not.toContain('id…')
    expect(server.requests).toHaveLength(0)
  })

  it('still accepts a real id', async () => {
    const ran = await runCli([`run`, `--uuid=${MONITOR_ID}`, '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.monitorId)).toEqual([MONITOR_ID, MONITOR_ID])
  })
})

describe('--name takes a name and says so when it is handed an id', () => {
  it('refuses an id behind --name and cuts it, rather than mailing the capability out with cron', async () => {
    const ran = await runCli([`run`, `--name=${MONITOR_ID}`, ...node('process.exit(3)')], {
      env: envFor(),
    })

    expect(ran.status).toBe(3)
    expect(ran.stderr).toContain('--uuid')
    expect(ran.stderr).toContain(`id…${MONITOR_ID.slice(-4)}`)
    expect(ran.stderr).not.toContain(MONITOR_ID)
    expect(ran.stdout).not.toContain(MONITOR_ID)
    expect(server.requests).toHaveLength(0)
  })

  it('applies the same reading to init, which offers the same two flags', async () => {
    const ran = await runCli(
      [`init`, `--name=${MONITOR_ID}`, `--uuid=${MONITOR_ID}`, '--print-env'],
      { env: envFor(), input: '' },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--uuid')
    expect(ran.stderr).not.toContain(MONITOR_ID)
    expect(ran.stdout).not.toContain(MONITOR_ID)
  })

  it('leaves an ordinary name alone', async () => {
    const ran = await runCli(['run', '--name=job', '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.action)).toEqual(['start', 'success'])
  })
})

// A crontab writes --uuid=$SOMETHING. The variable going missing expands to an empty flag
// value, which is the shape a wrapper must not read as a reason to skip the job.
describe('a monitor a crontab could no longer name never stops the command', () => {
  it.each([
    ['--uuid=', 'an empty --uuid'],
    ['--name=', 'an empty --name'],
    ['--uuid=job', 'a name behind --uuid'],
  ])('runs the command for %s and hands back its own status', async (flag) => {
    const ran = await runCli(['run', flag, ...node('console.log("RAN"); process.exit(6)')], {
      env: envFor(),
    })

    expect(ran.stdout).toContain('RAN')
    expect(ran.status).toBe(6)
    expect(ran.stderr).toContain('cronheart:')
    expect(ran.stderr).toContain('unmonitored')
    expect(server.requests).toHaveLength(0)
  })

  it('runs the command when both flags name a monitor and neither settles which', async () => {
    const ran = await runCli(
      ['run', '--name=job', `--uuid=${MONITOR_ID}`, ...node('console.log("RAN"); process.exit(6)')],
      { env: envFor() },
    )

    expect(ran.stdout).toContain('RAN')
    expect(ran.status).toBe(6)
    expect(ran.stderr).toContain('unmonitored')
    expect(server.requests).toHaveLength(0)
  })

  it('keeps 64 for an invocation naming no monitor at all, which no variable can produce', async () => {
    const ran = await runCli(['run', ...node('console.log("RAN")')], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stdout).not.toContain('RAN')
    expect(ran.stderr).toContain('--name')
  })

  it.each([
    ['nothing to run', ['run', '--name=job']],
    ['a flag that was given no value', ['run', '--name', '--', 'true']],
    ['an unknown flag', ['run', '--name=job', '--nope=1', '--', 'true']],
  ])('keeps 64 for %s, which is an invocation it could not read', async (_why, args) => {
    const ran = await runCli(args, { env: envFor() })

    expect(ran.status).toBe(64)
    expect(server.requests).toHaveLength(0)
  })
})
