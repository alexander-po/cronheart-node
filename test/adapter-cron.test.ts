import { describe, expect, it } from 'vitest'
import { monitored } from '../src/integrations/cron.js'
import {
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../src/wiring/errors.js'
import { clearWarnings } from '../src/testing.js'
import { ADAPTER_MONITOR, gate, harness } from './support/adapters.js'

type Tick = (this: unknown, onComplete: never) => unknown

function tickOf(params: { readonly onTick: unknown }): Tick {
  return params.onTick as Tick
}

function fire(params: { readonly onTick: unknown }, self: unknown = {}): Promise<unknown> {
  return Promise.resolve(tickOf(params).call(self, undefined as never))
}

describe('the kelektiv cron adapter', () => {
  it('gives back the same parameters with only onTick replaced', () => {
    const test = harness()
    const original = (): void => {}
    const params = monitored(
      ADAPTER_MONITOR,
      {
        cronTime: '0 3 * * *',
        onTick: original,
        timeZone: 'Europe/Berlin',
        waitForCompletion: true,
        name: 'backup',
      },
      { client: test.client },
    )

    expect(params.cronTime).toBe('0 3 * * *')
    expect(params.timeZone).toBe('Europe/Berlin')
    expect(params.waitForCompletion).toBe(true)
    expect(params.name).toBe('backup')
    expect(params.onTick).not.toBe(original)
    expect(typeof params.onTick).toBe('function')
  })

  it('brackets a run with a start and a success check-in, and gives the job’s value back', async () => {
    const test = harness()
    const produced = { rows: 3 }
    const params = monitored(
      ADAPTER_MONITOR,
      { cronTime: '0 3 * * *', onTick: () => produced, timeZone: 'Etc/UTC' },
      { client: test.client },
    )

    const returned = await fire(params)
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
    expect(returned).toBe(produced)
  })

  // cron calls the tick with the job as `this` unless a context was given, and a wrapper
  // that dropped it would break every job written as a `function` reading its own context.
  it('calls the job with the receiver and the onComplete argument cron passed it', async () => {
    const test = harness()
    const receiver = { marker: 'the job context' }
    const onComplete = (): void => {}
    let seenThis: unknown
    let seenArgument: unknown
    const params = monitored(
      ADAPTER_MONITOR,
      {
        cronTime: '0 3 * * *',
        timeZone: 'Etc/UTC',
        onTick: function (this: unknown, given: unknown) {
          seenThis = this
          seenArgument = given
        },
      },
      { client: test.client },
    )

    await tickOf(params).call(receiver, onComplete as never)
    await test.settled()

    expect(seenThis).toBe(receiver)
    expect(seenArgument).toBe(onComplete)
  })

  it('reports a failed run as a fail check-in carrying the error, and rethrows it unchanged', async () => {
    const test = harness()
    const failure = new Error('the invoice run could not reach the ledger')
    const params = monitored(
      ADAPTER_MONITOR,
      {
        cronTime: '0 3 * * *',
        timeZone: 'Etc/UTC',
        onTick: () => {
          throw failure
        },
      },
      { client: test.client },
    )

    const thrown = await fire(params).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(thrown).toBe(failure)
    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('could not reach the ledger')
  })

  it('collapses overlapping ticks into one bracket and names cron’s own guard', async () => {
    clearWarnings()
    const test = harness()
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }
    const held = gate()
    const params = monitored(
      ADAPTER_MONITOR,
      { cronTime: '* * * * *', timeZone: 'Etc/UTC', onTick: () => held.held },
      { client: test.client },
    )

    try {
      const first = fire(params)
      const second = fire(params)
      held.release()
      await Promise.all([first, second])
      await test.settled()
    } finally {
      console.warn = sink
    }

    expect(test.actions()).toEqual(['start', 'success'])
    expect(warnings.filter((line) => line.includes('waitForCompletion: true')).length).toBe(1)
  })

  it('refuses a six-field expression at wiring time, naming cron’s dialect', () => {
    const test = harness()

    expect(() =>
      monitored(
        ADAPTER_MONITOR,
        { cronTime: '*/30 * * * * *', onTick: () => undefined },
        { client: test.client },
      ),
    ).toThrow(InvalidScheduleError)
    expect(test.recorder.pings).toEqual([])
  })

  // cron takes a Date or a luxon DateTime as well as an expression, and a run-once job has
  // no dialect to disagree about — refusing one would refuse a legitimate configuration.
  it('leaves a run-once date alone rather than reading it as an expression', () => {
    const test = harness()
    const at = new Date(Date.now() + 60_000)
    const params = monitored(
      ADAPTER_MONITOR,
      { cronTime: at, onTick: () => undefined },
      { client: test.client },
    )

    expect(params.cronTime).toBe(at)
  })

  it('refuses a zone the runtime does not know, before a single tick has fired', () => {
    const test = harness()

    expect(() =>
      monitored(
        ADAPTER_MONITOR,
        { cronTime: '0 3 * * *', onTick: () => undefined, timeZone: 'Mars/Olympus' },
        { client: test.client },
      ),
    ).toThrow(InvalidTimezoneError)
  })

  it('refuses a monitor nothing resolves at wiring time', () => {
    const test = harness()

    expect(() =>
      monitored(
        'a-name-nothing-defines',
        { cronTime: '0 3 * * *', onTick: () => undefined },
        { client: test.client },
      ),
    ).toThrow(UnknownMonitorError)
  })
})
