import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_HEADER_NAME } from '../src/constants.js'
import { createPingClient } from '../src/ping/client.js'
import type { PingClientOptions, PingResult } from '../src/ping/types.js'
import { UnknownMonitorError } from '../src/wiring/errors.js'
import { clearWarnings, createPingRecorder } from '../src/testing.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000a1'
const BASE = 'https://ping.example'
const FLUSH_DEADLINE_MS = 30

let recorder = createPingRecorder()
let warnings: string[] = []

function later(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function client(extra: PingClientOptions = {}) {
  return createPingClient({ baseUrl: BASE, fetch: recorder.fetch, env: {}, ...extra })
}

function named(extra: PingClientOptions = {}) {
  return client({ monitors: { job: MONITOR_ID }, ...extra })
}

beforeEach(() => {
  recorder = createPingRecorder()
  warnings = []
  clearWarnings()
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('name resolution', () => {
  it('reads the screaming env var derived from the monitor name', async () => {
    await client({ env: { CRONHEART_NIGHTLY_BACKUP_UUID: MONITOR_ID } }).ping('nightly-backup')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('accepts a raw id anywhere a name is accepted', async () => {
    await client().ping(MONITOR_ID)

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('keeps the pre-rename env prefix working without scolding anyone for it', async () => {
    await client({ env: { CRON_MONITOR_JOB_UUID: MONITOR_ID } }).ping('job')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
    expect(warnings).toEqual([])
  })

  it('prefers an explicitly defined id over the environment', async () => {
    const other = '00000000-0000-4000-8000-0000000000b2'
    await client({ monitors: { job: MONITOR_ID }, env: { CRONHEART_JOB_UUID: other } }).ping('job')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('refuses a malformed id at wiring time rather than at three in the morning', () => {
    expect(() => client().monitors.define({ job: 'not-an-id' })).toThrow(/not a monitor id/i)
  })

  it('lets an explicit id win for a name whose first group happens to be hex', async () => {
    await client({ monitors: { 'deadbeef-nightly': MONITOR_ID } }).ping('deadbeef-nightly')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('reads the environment for such a name too, rather than reading the name as an id', async () => {
    await client({ env: { CRONHEART_DEADBEEF_NIGHTLY_UUID: MONITOR_ID } }).ping('deadbeef-nightly')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('reports such a monitor under its own name, not under a tail dressed up as an id', async () => {
    const result = await client({ monitors: { 'deadbeef-nightly': MONITOR_ID } }).ping(
      'deadbeef-nightly',
    )

    expect(result.monitor).toBe('deadbeef-nightly')
  })

  it('looks a name up in what was defined, not in what every object inherits', async () => {
    await client({ env: { CRONHEART_CONSTRUCTOR_UUID: MONITOR_ID } }).ping('constructor')

    expect(recorder.pings[0]?.monitorId).toBe(MONITOR_ID)
  })

  it('resolves a name to an id on demand, so a boot check can fail the deploy', () => {
    const sdk = named()

    expect(sdk.monitors.resolve('job')).toBe(MONITOR_ID)
    expect(() => sdk.monitors.resolve('missing')).toThrow(UnknownMonitorError)
  })
})

describe('withMonitor', () => {
  it('brackets the run and hands back the host value by identity', async () => {
    const value = { rows: 12 }

    const returned = await named().withMonitor('job', () => value)

    expect(returned).toBe(value)
    expect(recorder.pings.map((ping) => ping.action)).toEqual(['start', 'success'])
  })

  it('reports the failure and rethrows the host error untouched', async () => {
    const failure = new Error('backup blew up')
    const stack = failure.stack
    let caught: unknown

    await named()
      .withMonitor('job', () => Promise.reject(failure))
      .catch((error: unknown) => {
        caught = error
      })

    expect(caught).toBe(failure)
    expect((caught as Error).stack).toBe(stack)
    expect(recorder.pings.map((ping) => ping.action)).toEqual(['start', 'fail'])
    expect(recorder.pings[1]?.body).toContain('backup blew up')
  })

  it('keeps the stack out of the failure body unless it is asked for', async () => {
    const failure = new Error('boom')

    await named()
      .withMonitor('job', () => Promise.reject(failure))
      .catch(() => undefined)
    await named({ includeStack: true })
      .withMonitor('job', () => Promise.reject(failure))
      .catch(() => undefined)

    expect(recorder.pings[1]?.body).not.toContain('at ')
    expect(recorder.pings[3]?.body).toContain('at ')
  })

  it('runs the job without waiting for the start check-in to come back', async () => {
    recorder.respondWith({ hang: true })
    const sdk = named({ timeoutMs: 400, retries: 0 })
    const started = Date.now()
    let ranAfterMs: number | undefined

    void sdk.withMonitor('job', () => {
      ranAfterMs = Date.now() - started
    })
    await later(30)

    expect(ranAfterMs).toBeDefined()
    expect(ranAfterMs).toBeLessThan(30)
  })

  it('prefers a body the caller supplied over the description of the error', async () => {
    await named()
      .withMonitor('job', () => Promise.reject(new Error('backup blew up')), { body: 'stderr tail' })
      .catch(() => undefined)

    expect(recorder.pings[1]?.body).toBe('stderr tail')
  })

  it('measures the run and reports it on the terminal ping only', async () => {
    await named().withMonitor('job', () => undefined)

    expect(recorder.pings).toHaveLength(2)
    expect(recorder.pings[0]?.headers[RUNTIME_HEADER_NAME]).toBeUndefined()
    expect(recorder.pings[1]?.headers[RUNTIME_HEADER_NAME]).toMatch(/^[0-9]+$/)
  })
})

describe('startRun', () => {
  it('sends the start eagerly and settles once, however many times it is told to', async () => {
    const run = named().startRun('job')

    const first = await run.success()
    const second = await run.success()
    const third = await run.fail(new Error('too late'))

    expect(recorder.pings.map((ping) => ping.action)).toEqual(['start', 'success'])
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('sends the body the run was opened with, on the terminal check-in', async () => {
    const run = named().startRun('job', { body: 'run-level output' })
    await run.success()

    expect(recorder.pings[1]?.body).toBe('run-level output')
  })

  it('applies a terminal call\u2019s own options rather than reading one field of them', async () => {
    recorder.respondWith({ status: 500, body: 'boom' })
    const seen: PingResult[] = []
    const run = named({ retries: 0 }).startRun('job')

    await run.success({ retries: 2, onResult: (result) => seen.push(result) })

    expect(seen.map((result) => result.attempts)).toEqual([3])
  })

  it('carries the failure detail into the body of a failed run', async () => {
    const run = named().startRun('job')
    await run.fail(new Error('exit 137'))

    expect(recorder.pings[1]?.action).toBe('fail')
    expect(recorder.pings[1]?.body).toContain('exit 137')
  })
})

describe('checkInWith', () => {
  it('resolves at wiring time, so a bad name crashes the boot rather than a run', () => {
    expect(() => client().checkInWith('nightly-backup')).toThrow(UnknownMonitorError)
  })

  it('refuses an action this SDK will not emit, at wiring time', () => {
    expect(() => named().checkInWith('job', { action: 'run' as 'start' })).toThrow(
      /not a check-in action/i,
    )
  })

  it('returns a thunk that reports nothing and awaits through flush', async () => {
    const beat = named().checkInWith('job', { action: 'success' })

    expect(beat()).toBeUndefined()
    await beat.flush()

    expect(recorder.pings.map((ping) => ping.action)).toEqual(['success'])
  })
})

describe('flush', () => {
  it('waits for the pings already in flight', async () => {
    recorder.respondWith({ delayMs: 20 })
    const sdk = named()

    void sdk.ping('job')
    void sdk.success('job')
    await sdk.flush()

    expect(recorder.undrainedBodies).toBe(0)
    expect(recorder.pings).toHaveLength(2)
  })

  it('returns on its own deadline rather than waiting on a hung ping', async () => {
    recorder.respondWith({ hang: true })
    const sdk = named({ timeoutMs: 10_000 })

    void sdk.ping('job')
    const started = Date.now()
    await sdk.flush(FLUSH_DEADLINE_MS)

    expect(Date.now() - started).toBeLessThan(FLUSH_DEADLINE_MS * 8)
  })
})

describe('the off switches are audible', () => {
  it('reports an unresolvable monitor as suppressed and names the variable to set', async () => {
    const result = await client().ping('nightly-backup')

    expect(result.outcome).toBe('suppressed')
    expect(result.sent).toBe(false)
    expect(recorder.pings).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('CRONHEART_NIGHTLY_BACKUP_UUID')
  })

  it('reports the kill switch as disabled and says so once', async () => {
    const sdk = client({ monitors: { job: MONITOR_ID }, env: { CRONHEART_DISABLED: '1' } })

    const result = await sdk.ping('job')
    await sdk.ping('job')

    expect(result.outcome).toBe('disabled')
    expect(recorder.pings).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('CRONHEART_DISABLED')
  })

  it('warns once per process per configuration outcome and never for a transient one', async () => {
    recorder.respondWith({ status: 404, body: 'Monitor not found' })
    const sdk = named({ retries: 0 })
    await sdk.ping('job')
    await sdk.ping('job')

    recorder.respondWith({ status: 500, body: 'boom' })
    await sdk.ping('job')
    await sdk.ping('job')

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cronheart:')
  })

  it('hands results to onResult instead of the warner, so nobody gets double output', async () => {
    const seen: PingResult[] = []
    recorder.respondWith({ status: 404, body: 'Monitor not found' })

    await named({ retries: 0, onResult: (result) => seen.push(result) }).ping('job')

    expect(seen.map((result) => result.outcome)).toEqual(['not-found'])
    expect(warnings).toEqual([])
  })

  it('never puts the raw monitor id in a warning or a result label', async () => {
    recorder.respondWith({ status: 404, body: 'Monitor not found' })

    const byName = await named({ retries: 0 }).ping('job')
    clearWarnings()
    const byId = await client({ retries: 0 }).ping(MONITOR_ID)

    expect(byName.monitor).toBe('job')
    expect(byId.monitor).not.toContain(MONITOR_ID)
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).not.toContain(MONITOR_ID)
  })
})
