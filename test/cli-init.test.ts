import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { muteEchoWhile, upsertEnvLine } from '../src/cli/init.js'
import { type ApiServer, startApiServer } from './support/api-server.js'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'
import { type MonitorStore, channelRow, createMonitorStore } from './support/monitor-store.js'

function modeOf(path: string): string {
  return (statSync(path).mode & 0o777).toString(8)
}

let server: PingServer
let workspace: string

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function envFile(): string {
  return join(workspace, '.env')
}

beforeEach(async () => {
  server = await startPingServer()
  workspace = mkdtempSync(join(tmpdir(), 'cronheart-init-'))
})

afterEach(async () => {
  await server.close()
  rmSync(workspace, { recursive: true, force: true })
})

describe('cronheart init on the free path', () => {
  it('writes the variable, checks in and reports both', async () => {
    const ran = await runCli(
      ['init', '--name=nightly-backup', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(`CRONHEART_NIGHTLY_BACKUP_UUID=${MONITOR_ID}\n`)
    expect(server.requests.map((request) => [request.monitorId, request.action])).toEqual([
      [MONITOR_ID, null],
    ])
    expect(ran.stdout).toContain('CRONHEART_NIGHTLY_BACKUP_UUID')
    expect(ran.stdout).toContain('accepted')
  })

  it('points at the page where a monitor is created, because the free tier cannot create one here', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.stdout).toContain('https://cronheart.com/dashboard')
  })

  it('replaces the value already written for that variable instead of appending a second one', async () => {
    writeFileSync(
      envFile(),
      `DATABASE_URL=postgres://local\nCRONHEART_JOB_UUID=00000000-0000-4000-8000-0000000000ff\nOTHER=1\n`,
    )

    const ran = await runCli(['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`], {
      env: envFor(),
    })

    expect(ran.status).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(
      `DATABASE_URL=postgres://local\nCRONHEART_JOB_UUID=${MONITOR_ID}\nOTHER=1\n`,
    )
  })

  it('appends without disturbing what is already there', async () => {
    writeFileSync(envFile(), 'DATABASE_URL=postgres://local\n')

    await runCli(['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`], {
      env: envFor(),
    })

    expect(readFileSync(envFile(), 'utf8')).toBe(
      `DATABASE_URL=postgres://local\nCRONHEART_JOB_UUID=${MONITOR_ID}\n`,
    )
  })

  it('writes nothing to disk under --print-env but still verifies the id', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`, '--print-env'],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain(`CRONHEART_JOB_UUID=${MONITOR_ID}`)
    expect(() => readFileSync(envFile(), 'utf8')).toThrow()
    expect(server.requests).toHaveLength(1)
  })

  it('refuses a pasted value that is not a monitor id, before it writes anything', async () => {
    const ran = await runCli(
      ['init', '--name=job', '--uuid=nope', `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(64)
    expect(() => readFileSync(envFile(), 'utf8')).toThrow()
    expect(server.requests).toHaveLength(0)
  })

  it('takes the answers from stdin when the flags are not given', async () => {
    const ran = await runCli(['init', `--env-path=${envFile()}`], {
      env: envFor(),
      input: `nightly backup\n${MONITOR_ID}\n`,
    })

    expect(ran.status).toBe(0)
    expect(readFileSync(envFile(), 'utf8')).toBe(`CRONHEART_NIGHTLY_BACKUP_UUID=${MONITOR_ID}\n`)
    expect(server.requests).toHaveLength(1)
  })

  it('says what it cannot do rather than guessing when stdin answers nothing', async () => {
    const ran = await runCli(['init', `--env-path=${envFile()}`], { env: envFor(), input: '' })

    expect(ran.status).toBe(64)
    expect(server.requests).toHaveLength(0)
  })
})

describe('cronheart init and the paid path', () => {
  let store: MonitorStore
  let api: ApiServer

  const KEY = `cmk_${'0'.repeat(28)}synthetic`

  beforeEach(async () => {
    store = createMonitorStore([], [channelRow({ id: '7', label: 'ops inbox', verified: true })])
    api = await startApiServer(store)
  })

  afterEach(async () => {
    await api.close()
  })

  function paidEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      CRONHEART_URL: api.url,
      CRONHEART_API_KEY: KEY,
      CRONHEART_TIMEOUT_MS: '4000',
      CRONHEART_RETRIES: '0',
      ...extra,
    }
  }

  it('creates the monitor, writes the variable and checks in, all in one command', async () => {
    const ran = await runCli(
      ['init', '--name=nightly-backup', '--schedule=0 3 * * *', `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(ran.status).toBe(0)
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['nightly-backup'])
    expect(store.monitors[0]?.schedule_expr).toBe('0 3 * * *')
    expect(readFileSync(envFile(), 'utf8')).toMatch(/^CRONHEART_NIGHTLY_BACKUP_UUID=/m)
    expect(store.requests.filter((request) => request.path.startsWith('/ping/'))).toHaveLength(1)
  })

  // The web form pre-selects the account's verified channels and the REST surface does not,
  // so a monitor created here without them would be one nothing ever alerts about.
  it('attaches the account’s verified channels and says which', async () => {
    const ran = await runCli(
      ['init', '--name=job', '--schedule=@daily', `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(store.monitors[0]?.channel_ids).toEqual(['7'])
    expect(ran.stdout).toContain('ops inbox')
  })

  it('refuses to create a monitor that would alert nobody, and creates nothing', async () => {
    store.channels.splice(0, store.channels.length)

    const ran = await runCli(
      ['init', '--name=job', '--schedule=@daily', `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(ran.status).toBe(1)
    expect(store.monitors).toEqual([])
    expect(`${ran.stdout}${ran.stderr}`).toContain('nobody')
    expect(() => readFileSync(envFile(), 'utf8')).toThrow()
  })

  it('refuses a schedule the service would refuse, before it creates anything', async () => {
    const ran = await runCli(
      ['init', '--name=job', '--schedule=*/5 * * * * *', `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('seconds')
    expect(store.monitors).toEqual([])
  })

  it('takes the id it was handed instead of creating a second monitor for it', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(ran.status).toBe(0)
    expect(store.monitors).toEqual([])
    expect(readFileSync(envFile(), 'utf8')).toContain(MONITOR_ID)
  })

  it('says the plan a REST token needs in its own words, and falls back to pasting an id', async () => {
    store.denyWithPlanRestriction = true

    const ran = await runCli(['init', `--env-path=${envFile()}`, '--name=job'], {
      env: paidEnv(),
      input: `${MONITOR_ID}\n`,
    })

    expect(ran.stdout).toContain('Starter')
    expect(ran.stdout).toContain('every plan')
    expect(`${ran.stdout}${ran.stderr}`).not.toContain(KEY)
    expect(readFileSync(envFile(), 'utf8')).toContain(MONITOR_ID)
    expect(store.monitors).toEqual([])
  })

  it('never puts the key it authenticated with anywhere a reader can see it', async () => {
    const ran = await runCli(
      ['init', '--name=job', '--schedule=@daily', `--env-path=${envFile()}`],
      { env: paidEnv() },
    )

    expect(`${ran.stdout}${ran.stderr}`).not.toContain(KEY)
    expect(readFileSync(envFile(), 'utf8')).not.toContain(KEY)
  })
})

// The file holds the monitor id, which is the entire credential on the check-in route: anyone
// who can read it can forge check-ins and hold a dead job open as healthy.
describe('the file cronheart init writes', () => {
  it('creates one nobody but its owner can read', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(modeOf(envFile())).toBe('600')
  })

  it('leaves the permissions of a file that was already there as they were', async () => {
    writeFileSync(envFile(), 'DATABASE_URL=postgres://local\n')
    chmodSync(envFile(), 0o640)

    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(modeOf(envFile())).toBe('640')
    expect(readFileSync(envFile(), 'utf8')).toContain(MONITOR_ID)
  })

  it('refuses to write through a symbolic link, and leaves what it points at alone', async () => {
    const elsewhere = join(workspace, 'somewhere-else')

    writeFileSync(elsewhere, 'untouched\n')
    symlinkSync(elsewhere, envFile())

    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('symbolic link')
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a path it cannot read rather than replacing it with a single line', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${workspace}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('cannot be read')
    expect(readdirSync(workspace)).toEqual([])
  })

  it('reads a destination directory that does not exist as the typo it is', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${join(workspace, 'no-dir', '.env')}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('no-dir')
    expect(ran.stderr).toContain('does not exist')
    expect(ran.stderr).not.toContain('ENOENT')
    expect(readdirSync(workspace)).toEqual([])
    expect(server.requests).toHaveLength(0)
  })
})

describe('the line cronheart init rewrites', () => {
  it('replaces the variable it was asked to, not one whose name merely looks like it', () => {
    const existing = 'A.B=old\nAXB=other\n'

    expect(upsertEnvLine(existing, 'A.B', 'new')).toBe('A.B=new\nAXB=other\n')
  })

  it('treats a name carrying regular-expression punctuation as the literal text it is', () => {
    expect(upsertEnvLine('A+B=old\n', 'A+B', 'new')).toBe('A+B=new\n')
    expect(upsertEnvLine('AAB=old\n', 'A+B', 'new')).toBe('AAB=old\nA+B=new\n')
  })
})

describe('the prompt that asks for the monitor id', () => {
  it('writes nothing back while the answer being typed is the id', () => {
    const written: string[] = []
    const session: { output: { write(text: string): void }; _writeToOutput?: (text: string) => void } = {
      output: { write: (text) => written.push(text) },
    }
    let asking = 'uuid'

    muteEchoWhile(session, () => asking === 'uuid')
    session._writeToOutput?.('0')
    session._writeToOutput?.('0')
    asking = 'name'
    session._writeToOutput?.('n')

    expect(written).toEqual(['n'])
  })
})

describe('where cronheart init leaves the reader', () => {
  it('closes with the crontab line, because the file it wrote is not what cron reads', async () => {
    const ran = await runCli(
      ['init', '--name=nightly-backup', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('cron')
    expect(ran.stdout).toMatch(/^\s*CRONHEART_NIGHTLY_BACKUP_UUID=/m)
    expect(ran.stdout).toMatch(/\s\/\S*cronheart run --name=nightly-backup /)
  })

  it('does not put the id it was handed back on the terminal it was pasted into', async () => {
    const ran = await runCli(
      ['init', '--name=nightly-backup', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor() },
    )

    expect(ran.status).toBe(0)
    expect(`${ran.stdout}${ran.stderr}`).not.toContain(MONITOR_ID)
  })
})
