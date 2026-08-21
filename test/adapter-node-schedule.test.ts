import { describe, expect, it } from 'vitest'
import { monitored } from '../src/integrations/node-schedule.js'
import {
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../src/wiring/errors.js'
import { clearWarnings } from '../src/testing.js'
import { ADAPTER_MONITOR, ADAPTER_MONITOR_ID, gate, harness } from './support/adapters.js'

type Invocation = (fireDate: Date) => unknown

function invoke(args: readonly unknown[]): Promise<unknown> {
  return Promise.resolve((args[2] as Invocation)(new Date()))
}

describe('the node-schedule adapter', () => {
  it('hands scheduleJob a name, the spec it was given, and a callback of its own', () => {
    const test = harness()
    const spec = { rule: '0 3 * * *', tz: 'Europe/Berlin' }
    const original = (): void => {}
    const args = monitored(ADAPTER_MONITOR, spec, original, { client: test.client })

    expect(args[0]).toBe(ADAPTER_MONITOR)
    expect(args[1]).toBe(spec)
    expect(args[2]).not.toBe(original)
    expect(args.length).toBe(3)
  })

  it('brackets a run with a start and a success check-in, and gives the job’s value back', async () => {
    const test = harness()
    const produced = { rows: 5 }
    const args = monitored(ADAPTER_MONITOR, '0 3 * * *', () => produced, {
      client: test.client,
    })

    const returned = await invoke(args)
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
    expect(returned).toBe(produced)
    expect(test.recorder.pings.map((ping) => ping.monitorId)).toEqual([
      ADAPTER_MONITOR_ID,
      ADAPTER_MONITOR_ID,
    ])
  })

  // node-schedule passes the scheduled fire date to every callback, and a job that logs it
  // or bases its window on it reads a different run entirely if the wrapper invents one.
  it('passes node-schedule’s own fire date through to the job', async () => {
    const test = harness()
    const fired = new Date('2026-02-03T03:00:00.000Z')
    let seen: unknown
    const args = monitored(
      ADAPTER_MONITOR,
      '0 3 * * *',
      (given: Date) => {
        seen = given
      },
      { client: test.client },
    )

    await Promise.resolve((args[2] as Invocation)(fired))
    await test.settled()

    expect(seen).toBe(fired)
  })

  it('reports a failed run as a fail check-in carrying the error, and rethrows it unchanged', async () => {
    const test = harness()
    const failure = new Error('the report job could not write its output')
    const args = monitored(
      ADAPTER_MONITOR,
      '0 3 * * *',
      () => {
        throw failure
      },
      { client: test.client },
    )

    const thrown = await invoke(args).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(thrown).toBe(failure)
    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('could not write its output')
  })

  // node-schedule has no overlap guard of its own: it fires a new invocation whether or not
  // the last one finished, so the adapter says so rather than naming an option that is not there.
  it('collapses overlapping invocations into one bracket and says node-schedule has no guard', async () => {
    clearWarnings()
    const test = harness()
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }
    const held = gate()
    const args = monitored(ADAPTER_MONITOR, '* * * * *', () => held.held, {
      client: test.client,
    })

    try {
      const first = invoke(args)
      const second = invoke(args)
      held.release()
      await Promise.all([first, second])
      await test.settled()
    } finally {
      console.warn = sink
    }

    expect(test.actions()).toEqual(['start', 'success'])
    expect(warnings.filter((line) => line.includes('no overlap guard')).length).toBe(1)
  })

  it('refuses a six-field expression at wiring time, naming node-schedule’s dialect', () => {
    const test = harness()

    expect(() =>
      monitored(ADAPTER_MONITOR, '0 0 3 * * *', () => undefined, { client: test.client }),
    ).toThrow(InvalidScheduleError)
    expect(() =>
      monitored(ADAPTER_MONITOR, { rule: '0 0 3 * * *' }, () => undefined, {
        client: test.client,
      }),
    ).toThrow(InvalidScheduleError)
    expect(test.recorder.pings).toEqual([])
  })

  // A recurrence-rule object and a one-off Date are not cron at all, so there is no dialect
  // to disagree about and refusing them would refuse a legitimate schedule.
  it('leaves a rule object and a one-off date alone rather than reading them as expressions', () => {
    const test = harness()
    const at = new Date(Date.now() + 60_000)

    expect(() =>
      monitored(ADAPTER_MONITOR, { hour: 3, minute: 0 }, () => undefined, {
        client: test.client,
      }),
    ).not.toThrow()
    expect(monitored(ADAPTER_MONITOR, at, () => undefined, { client: test.client })[1]).toBe(at)
  })

  it('refuses a zone the runtime does not know, before a single invocation has fired', () => {
    const test = harness()

    expect(() =>
      monitored(ADAPTER_MONITOR, { rule: '0 3 * * *', tz: 'Europe/Berlim' }, () => undefined, {
        client: test.client,
      }),
    ).toThrow(InvalidTimezoneError)
  })

  it('refuses a monitor nothing resolves at wiring time', () => {
    const test = harness()

    expect(() =>
      monitored('a-name-nothing-defines', '0 3 * * *', () => undefined, {
        client: test.client,
      }),
    ).toThrow(UnknownMonitorError)
  })
})
