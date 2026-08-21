import { describe, expect, it } from 'vitest'
import { monitored } from '../src/integrations/croner.js'
import {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../src/wiring/errors.js'
import { clearWarnings } from '../src/testing.js'
import { ADAPTER_MONITOR, ADAPTER_MONITOR_ID, gate, harness } from './support/adapters.js'

type Tick = (self: never, context: never) => unknown

function run(args: readonly unknown[]): Tick {
  return args[2] as Tick
}

function tick(args: readonly unknown[]): Promise<unknown> {
  return Promise.resolve(run(args)(undefined as never, undefined as never))
}

describe('the croner adapter', () => {
  it('hands croner its own argument list back, pattern and options untouched', () => {
    const test = harness()
    const options = { timezone: 'Europe/Berlin', protect: true }
    const args = monitored(ADAPTER_MONITOR, '0 3 * * *', options, () => undefined, {
      client: test.client,
    })

    expect(args[0]).toBe('0 3 * * *')
    expect(args[1]).toBe(options)
    expect(typeof args[2]).toBe('function')
    expect(args.length).toBe(3)
  })

  it('brackets a run with a start and a success check-in, and gives the job’s value back', async () => {
    const test = harness()
    const produced = { rows: 12 }
    const args = monitored(
      ADAPTER_MONITOR,
      '0 3 * * *',
      { timezone: 'Etc/UTC' },
      () => produced,
      { client: test.client },
    )

    const returned = await tick(args)
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
    expect(returned).toBe(produced)
    expect(test.recorder.pings.map((ping) => ping.monitorId)).toEqual([
      ADAPTER_MONITOR_ID,
      ADAPTER_MONITOR_ID,
    ])
  })

  it('reports a failed run as a fail check-in carrying the error, and rethrows it unchanged', async () => {
    const test = harness()
    const failure = new Error('the backup could not open its target')
    const args = monitored(
      ADAPTER_MONITOR,
      '0 3 * * *',
      { timezone: 'Etc/UTC' },
      () => {
        throw failure
      },
      { client: test.client },
    )

    const thrown = await tick(args).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(thrown).toBe(failure)
    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('the backup could not open its target')
  })

  it('waits for the terminal check-in before the tick resolves, so a short process cannot outrun it', async () => {
    const test = harness()
    let landed = false
    test.recorder.respondWith(() => ({ delayMs: 40 }))
    const args = monitored(ADAPTER_MONITOR, '0 3 * * *', {}, () => undefined, {
      client: test.client,
      onResult: (result) => {
        if (result.action === 'success') {
          landed = true
        }
      },
    })

    await tick(args)

    expect(landed).toBe(true)
  })

  it('collapses overlapping runs into one bracket and names croner’s own guard', async () => {
    clearWarnings()
    const test = harness()
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }
    const held = gate()
    const args = monitored(ADAPTER_MONITOR, '* * * * *', {}, () => held.held, {
      client: test.client,
    })

    try {
      const first = tick(args)
      const second = tick(args)
      held.release()
      await Promise.all([first, second])
      await test.settled()
    } finally {
      console.warn = sink
    }

    expect(test.actions()).toEqual(['start', 'success'])
    expect(warnings.filter((line) => line.includes('protect: true')).length).toBe(1)
  })

  it('reports the run as failed when any of the collapsed runs failed', async () => {
    const test = harness()
    const held = gate()
    let first = true
    const args = monitored(
      ADAPTER_MONITOR,
      '* * * * *',
      {},
      () => {
        if (first) {
          first = false

          return held.held
        }

        throw new Error('the second tick failed')
      },
      { client: test.client },
    )

    const slow = tick(args)
    await tick(args).catch(() => undefined)
    held.release()
    await slow
    await test.settled()

    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('the second tick failed')
  })

  it('refuses a six-field expression at wiring time, naming croner’s dialect', () => {
    const test = harness()

    expect(() =>
      monitored(ADAPTER_MONITOR, '0 0 3 * * *', {}, () => undefined, { client: test.client }),
    ).toThrow(InvalidScheduleError)
    expect(() =>
      monitored(ADAPTER_MONITOR, '0 0 3 * * *', {}, () => undefined, { client: test.client }),
    ).toThrow(/croner/)
    expect(test.recorder.pings).toEqual([])
  })

  it('takes the seven aliases the service knows and refuses the ones only croner resolves', () => {
    const test = harness()

    expect(() =>
      monitored(ADAPTER_MONITOR, '@daily', {}, () => undefined, { client: test.client }),
    ).not.toThrow()
    expect(() =>
      monitored(ADAPTER_MONITOR, '@reboot', {}, () => undefined, { client: test.client }),
    ).toThrow(InvalidScheduleError)
  })

  it('refuses a zone the runtime does not know, before a single tick has fired', () => {
    const test = harness()

    expect(() =>
      monitored(ADAPTER_MONITOR, '0 3 * * *', { timezone: 'Europe/Berlim' }, () => undefined, {
        client: test.client,
      }),
    ).toThrow(InvalidTimezoneError)
  })

  it('refuses a monitor nothing resolves at wiring time rather than at three in the morning', () => {
    const test = harness()

    expect(() =>
      monitored('a-name-nothing-defines', '0 3 * * *', {}, () => undefined, {
        client: test.client,
      }),
    ).toThrow(UnknownMonitorError)
  })

  // Every adapter reads its own options off an object the host wrote, and a getter on one
  // can throw. What leaves the call has to be the type the caller was told to catch.
  it('turns an options object that explodes when read into a configuration error', () => {
    const test = harness()
    const hostile: Record<string, unknown> = { client: test.client }
    Object.defineProperty(hostile, 'timeoutMs', {
      enumerable: true,
      get: () => {
        throw new TypeError('the timeout the caller passed in exploded')
      },
    })

    let thrown: unknown
    try {
      monitored(ADAPTER_MONITOR, '0 3 * * *', {}, () => undefined, hostile)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CronheartConfigurationError)
    expect(thrown).not.toBeInstanceOf(TypeError)
  })

  // Two monitors, not one: the warning ledger is keyed by monitor, so asserting that the
  // second call stayed quiet with the same name would only prove the ledger deduplicates.
  it('says which zone an hour-of-the-day schedule will actually fire in when none was named', () => {
    clearWarnings()
    const test = harness({
      'pinned-to-an-hour': ADAPTER_MONITOR_ID,
      'every-five-minutes': ADAPTER_MONITOR_ID,
    })
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }

    try {
      monitored('pinned-to-an-hour', '0 3 * * *', {}, () => undefined, { client: test.client })
      monitored('every-five-minutes', '*/5 * * * *', {}, () => undefined, {
        client: test.client,
      })
    } finally {
      console.warn = sink
    }

    expect(warnings.filter((line) => line.includes('no zone was named'))).toEqual([
      expect.stringContaining('"pinned-to-an-hour"'),
    ])
  })

  // croner takes the offset as an alternative to the zone name, so an absent timezone
  // alongside one is not evidence that the caller named nothing. The second monitor is the
  // positive control: without it, a suppressed warning reads like a broken capture.
  it('reads croner\'s utcOffset as a zone the caller named, and says nothing about it', () => {
    clearWarnings()
    const test = harness({
      'zone-named-as-an-offset': ADAPTER_MONITOR_ID,
      'no-zone-named-at-all': ADAPTER_MONITOR_ID,
    })
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }

    try {
      monitored('zone-named-as-an-offset', '0 3 * * *', { utcOffset: 120 }, () => undefined, {
        client: test.client,
      })
      monitored('no-zone-named-at-all', '0 3 * * *', {}, () => undefined, { client: test.client })
    } finally {
      console.warn = sink
    }

    expect(warnings.filter((line) => line.includes('no zone was named'))).toEqual([
      expect.stringContaining('"no-zone-named-at-all"'),
    ])
  })
})
