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

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('cronheart ping', () => {
  it('sends a bare heartbeat when no action is asked for', async () => {
    const ran = await runCli(['ping', 'job'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => [request.method, request.monitorId, request.action])).toEqual(
      [['GET', MONITOR_ID, null]],
    )
  })

  it.each(['start', 'success', 'fail'])('emits the %s segment verbatim', async (action) => {
    const ran = await runCli(['ping', 'job', `--action=${action}`], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.action)).toEqual([action])
  })

  it('takes a monitor id in place of a name', async () => {
    const ran = await runCli(['ping', MONITOR_ID], {
      env: { CRONHEART_URL: server.url, CRONHEART_TIMEOUT_MS: '2000' },
    })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.monitorId)).toEqual([MONITOR_ID])
  })

  it('sends the body as a POST and reports it back', async () => {
    const ran = await runCli(['ping', 'job', '--action=fail', '--body=disk full'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => [request.method, request.body])).toEqual([
      ['POST', 'disk full'],
    ])
  })

  it('reads the body from stdin when it is a bare dash', async () => {
    const ran = await runCli(['ping', 'job', '--action=fail', '--body=-'], {
      env: envFor(),
      input: 'piped failure detail\n',
    })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.body)).toEqual(['piped failure detail\n'])
  })
})

describe('cronheart ping refuses an action the server would silently read as a heartbeat', () => {
  it.each(['run', 'ok', '0', '-1', '7', 'START', 'Success', 'heartbeat', 'succeeded', ''])(
    'exits 64 on --action=%s before any URL exists',
    async (action) => {
      const ran = await runCli(['ping', 'job', `--action=${action}`], { env: envFor() })

      expect(ran.status).toBe(64)
      expect(server.requests).toHaveLength(0)
      expect(ran.stderr).toContain('cronheart:')
    },
  )

  it('names the three segments it will emit, so the message is actionable', async () => {
    const ran = await runCli(['ping', 'job', '--action=run'], { env: envFor() })

    expect(ran.stderr).toContain('start')
    expect(ran.stderr).toContain('success')
    expect(ran.stderr).toContain('fail')
  })
})

describe('cronheart ping keeps a failed check-in out of the caller’s exit code', () => {
  it('exits 0 when the server rejects the check-in, and says so on stderr', async () => {
    server.replyWith(() => ({ status: 500, body: 'nope' }))

    const ran = await runCli(['ping', 'job'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(ran.stderr).toContain('cronheart:')
  })

  it('exits 1 for the same check-in once --strict is asked for', async () => {
    server.replyWith(() => ({ status: 500, body: 'nope' }))

    const ran = await runCli(['ping', 'job', '--strict'], { env: envFor() })

    expect(ran.status).toBe(1)
    expect(server.requests).toHaveLength(1)
  })

  it('reports an accepted check-in on stdout and exits 0', async () => {
    const ran = await runCli(['ping', 'job', '--strict'], { env: envFor() })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('accepted')
  })

  it('sends nothing and exits 0 when the name resolves to no monitor', async () => {
    const ran = await runCli(['ping', 'absent'], { env: { CRONHEART_URL: server.url } })

    expect(ran.status).toBe(0)
    expect(server.requests).toHaveLength(0)
    expect(ran.stderr).toContain('cronheart:')
  })

  it('exits 64 when no monitor is named at all', async () => {
    const ran = await runCli(['ping'], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(server.requests).toHaveLength(0)
  })
})
