import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MONITOR_ID, OTHER_MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

let server: PingServer

function envFor(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    CRONHEART_URL: server.url,
    CRONHEART_TIMEOUT_MS: '2000',
    CRONHEART_RETRIES: '0',
    ...extra,
  }
}

function lineFor(report: string, name: string): string {
  return report.split('\n').find((line) => line.trim().startsWith(name)) ?? ''
}

function skewSeconds(report: string): number | undefined {
  const match = /this host is ([0-9]+) s (?:ahead of|behind) the server/.exec(report)

  return match === null ? undefined : Number(match[1])
}

beforeEach(async () => {
  server = await startPingServer()
})

afterEach(async () => {
  await server.close()
})

describe('cronheart doctor reports the configuration it actually resolved', () => {
  it('names the environment variable that answered for each configured monitor', async () => {
    const ran = await runCli(['doctor'], {
      env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID, CRONHEART_NIGHTLY_BACKUP_UUID: OTHER_MONITOR_ID }),
    })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('CRONHEART_JOB_UUID')
    expect(ran.stdout).toContain('CRONHEART_NIGHTLY_BACKUP_UUID')
  })

  it('says when the legacy variable name is the leg that answered', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRON_MONITOR_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('CRON_MONITOR_JOB_UUID')
    expect(ran.stdout).toContain('legacy')
  })

  it('never prints the monitor id, which is the whole credential for the ping route', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('CRONHEART_JOB_UUID')
    expect(ran.stdout).toContain('accepted')
    expect(`${ran.stdout}${ran.stderr}`).not.toContain(MONITOR_ID)
  })

  it('fails on a value that is not a monitor id rather than reporting it as configured', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRONHEART_JOB_UUID: 'not-an-id' }) })

    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('not a monitor id')
  })

  it('is loud about the kill switch and treats it as a problem, not a preference', async () => {
    const ran = await runCli(['doctor'], {
      env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID, CRONHEART_DISABLED: '1' }),
    })

    expect(ran.status).toBe(1)
    expect(ran.stdout).toContain('CRONHEART_DISABLED')
    expect(server.requests).toHaveLength(0)
  })
})

describe('cronheart doctor sends a real check-in', () => {
  it('checks in for the monitor it was handed and reports the answer', async () => {
    const ran = await runCli(['doctor', 'job'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => [request.monitorId, request.action])).toEqual([
      [MONITOR_ID, null],
    ])
    expect(ran.stdout).toContain('accepted')
  })

  it('fails when the server rejects the check-in', async () => {
    server.replyWith(() => ({ status: 404, body: 'Not Found' }))

    const ran = await runCli(['doctor', 'job'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(1)
    expect(server.requests).toHaveLength(1)
    expect(ran.stdout).toContain('not-found')
    expect(ran.stdout).toContain('does not recognise')
    expect(ran.stdout).toContain('CRONHEART_JOB_UUID')
  })

  it('checks in for a monitor that resolves rather than the first one alphabetically', async () => {
    const ran = await runCli(['doctor'], {
      env: envFor({ CRONHEART_AAA_BROKEN_UUID: 'not-an-id', CRONHEART_ZZZ_JOB_UUID: MONITOR_ID }),
    })

    expect(ran.status).toBe(1)
    expect(server.requests.map((request) => request.monitorId)).toEqual([MONITOR_ID])
    expect(ran.stdout).toContain('not a monitor id')
  })

  it('says it sent nothing when every configured monitor is malformed', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRONHEART_JOB_UUID: 'not-an-id' }) })

    expect(ran.status).toBe(1)
    expect(server.requests).toHaveLength(0)
    expect(ran.stdout).toContain('nothing to check in for')
  })

  it('says it sent nothing when no monitor is configured anywhere', async () => {
    const ran = await runCli(['doctor'], { env: envFor() })

    expect(server.requests).toHaveLength(0)
    expect(ran.stdout).toContain('no monitor')
  })
})

describe('cronheart doctor reports the clock', () => {
  it('reads the skew off the answer to its own check-in', async () => {
    server.replyWith(() => ({ headers: { Date: new Date(Date.now() - 7_200_000).toUTCString() } }))

    const ran = await runCli(['doctor', 'job'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(server.requests).toHaveLength(1)
    expect(skewSeconds(ran.stdout)).toBeGreaterThan(7000)
    expect(skewSeconds(ran.stdout)).toBeLessThan(7400)
    expect(ran.stdout).toContain('ahead of the server')
  })

  it('says the clocks agree when they do, rather than reporting a skew of nearly zero', async () => {
    const ran = await runCli(['doctor', 'job'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(server.requests).toHaveLength(1)
    expect(skewSeconds(ran.stdout)).toBeUndefined()
    expect(ran.stdout).toContain('in step with the server')
  })
})

describe('cronheart doctor says which tier you are on', () => {
  it('says nothing about plans when nothing is wrong and no key is configured', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(0)
    expect(ran.stdout).not.toContain('Starter')
    expect(ran.stdout).not.toContain('pricing')
  })

  it('names the plan requirement in its own words when a key is configured', async () => {
    const ran = await runCli(['doctor'], {
      env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID, CRONHEART_API_KEY: 'cmk_notarealkey' }),
    })

    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain('Starter')
    expect(ran.stdout).toContain('every plan')
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('cmk_notarealkey')
  })
})

describe('cronheart doctor and the base URL it reports', () => {
  it('prints the origin alone, because its output is what goes into a support thread', async () => {
    const ran = await runCli(['doctor'], {
      env: envFor({
        CRONHEART_URL: server.url.replace('http://', 'http://someone:hunter2-not-real@'),
        CRONHEART_JOB_UUID: MONITOR_ID,
      }),
    })

    expect(`${ran.stdout}${ran.stderr}`).not.toContain('hunter2-not-real')
    expect(ran.stdout).toContain(server.url)
  })

  it('names the legacy variable when that is the one that answered, not the canonical one', async () => {
    const ran = await runCli(['doctor'], {
      env: {
        CRON_MONITOR_URL: server.url,
        CRON_MONITOR_TIMEOUT_MS: '2000',
        CRON_MONITOR_DISABLED: '1',
      },
    })

    expect(lineFor(ran.stdout, 'base url')).toContain('CRON_MONITOR_URL')
    expect(lineFor(ran.stdout, 'kill switch')).toContain('CRON_MONITOR_DISABLED is set')
    expect(ran.stdout).not.toContain('CRONHEART_URL')
    expect(ran.stdout).not.toContain('CRONHEART_DISABLED')
  })

  it('says the URL is unusable without echoing the credential that made it so', async () => {
    const ran = await runCli(['ping', 'job'], {
      env: envFor({
        CRONHEART_URL: 'https://someone:hunter2-not-real@host.invalid',
        CRONHEART_JOB_UUID: MONITOR_ID,
      }),
    })

    expect(ran.stderr).toContain('cronheart:')
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('hunter2-not-real')
    expect(server.requests).toHaveLength(0)
  })
})

describe('what cronheart doctor cannot see, said where a reader looks for reassurance', () => {
  it('states that neither routing nor channel verification was among its checks', async () => {
    const ran = await runCli(['doctor'], { env: envFor({ CRONHEART_JOB_UUID: MONITOR_ID }) })
    const caveat = lineFor(ran.stdout, 'not checked')

    expect(ran.status).toBe(0)
    expect(caveat).toContain('channel')
    expect(caveat).toContain('verified')
  })
})

describe('cronheart doctor and a name it cannot resolve', () => {
  it('connects the name it was handed to the ones it listed two lines above', async () => {
    const ran = await runCli(['doctor', 'typo'], {
      env: envFor({
        CRONHEART_JOB_UUID: MONITOR_ID,
        CRONHEART_NIGHTLY_BACKUP_UUID: OTHER_MONITOR_ID,
      }),
    })
    const line = lineFor(ran.stdout, 'check-in')

    expect(ran.status).toBe(1)
    expect(server.requests).toHaveLength(0)
    expect(line).toContain('"typo"')
    expect(line).toContain('job')
    expect(line).toContain('nightly-backup')
  })

  it('still checks in for a name that resolves through a legacy variable', async () => {
    const ran = await runCli(['doctor', 'job'], { env: envFor({ CRON_MONITOR_JOB_UUID: MONITOR_ID }) })

    expect(ran.status).toBe(0)
    expect(server.requests.map((request) => request.monitorId)).toEqual([MONITOR_ID])
  })
})
