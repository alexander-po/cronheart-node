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

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('--uuid takes an id and says so when it is handed something else', () => {
  it('refuses a name behind --uuid rather than resolving it as one', async () => {
    const ran = await runCli(['run', '--uuid=job', '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--uuid')
    expect(ran.stderr).toContain('--name')
    expect(server.requests).toHaveLength(0)
  })

  it('shows a mistyped id back and states the shape it failed to match', async () => {
    const ran = await runCli([`run`, `--uuid=${NEARLY_AN_ID}`, '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(64)
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
  it('refuses an id behind --name rather than printing it back redacted', async () => {
    const ran = await runCli([`run`, `--name=${MONITOR_ID}`, '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--uuid')
    expect(server.requests).toHaveLength(0)
  })

  it('applies the same reading to init, which offers the same two flags', async () => {
    const ran = await runCli(
      [`init`, `--name=${MONITOR_ID}`, `--uuid=${MONITOR_ID}`, '--print-env'],
      { env: envFor(), input: '' },
    )

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('--uuid')
    expect(ran.stdout).not.toContain(MONITOR_ID)
  })

  it('leaves an ordinary name alone', async () => {
    const ran = await runCli(['run', '--name=job', '--', 'true'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.action)).toEqual(['start', 'success'])
  })
})
