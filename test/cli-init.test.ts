import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

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
  it('states the boundary rather than pretending to create the monitor when a key is configured', async () => {
    const ran = await runCli(
      ['init', '--name=job', `--uuid=${MONITOR_ID}`, `--env-path=${envFile()}`],
      { env: envFor({ CRONHEART_API_KEY: 'cmk_notarealkey' }) },
    )

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('Starter')
    expect(ran.stdout).toContain('every plan')
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('cmk_notarealkey')
    expect(readFileSync(envFile(), 'utf8')).toContain(MONITOR_ID)
  })
})
