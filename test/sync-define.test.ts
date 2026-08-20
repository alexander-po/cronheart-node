import { describe, expect, it } from 'vitest'
import { defineMonitors } from '../src/sync/define.js'
import { SyncConfigurationError } from '../src/sync/errors.js'
import type { DefinedMonitor, MonitorDefinition } from '../src/sync/types.js'

function first(definition: MonitorDefinition): DefinedMonitor {
  const defined = defineMonitors([definition]).monitors[0]

  if (defined === undefined) {
    throw new Error('defineMonitors returned nothing to inspect')
  }

  return defined
}

function scheduleOf(schedule: MonitorDefinition['schedule']): { kind: string; expr: string } {
  const defined = first({ name: 'a-job', schedule, channels: 'none' })

  return { kind: defined.scheduleKind, expr: defined.scheduleExpr }
}

function refusal(definition: MonitorDefinition): string {
  try {
    defineMonitors([definition])
  } catch (error) {
    if (error instanceof SyncConfigurationError) {
      return error.message
    }

    throw error
  }

  throw new Error('the configuration was accepted')
}

describe('the schedule a configuration writes', () => {
  it('reads a five-field string as cron and sends it as written', () => {
    expect(scheduleOf('0 3 * * *')).toEqual({ kind: 'cron', expr: '0 3 * * *' })
  })

  it('reads each of the seven aliases as cron, in whatever case they were written', () => {
    for (const alias of ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']) {
      expect(scheduleOf(alias)).toEqual({ kind: 'cron', expr: alias })
      expect(scheduleOf(alias.toUpperCase())).toEqual({ kind: 'cron', expr: alias.toUpperCase() })
    }
  })

  it('reads each of the twelve fixed tokens as a preset', () => {
    for (const token of [
      'every_minute',
      'every_5_minutes',
      'every_10_minutes',
      'every_15_minutes',
      'every_30_minutes',
      'hourly',
      'every_2_hours',
      'every_6_hours',
      'daily',
      'daily_morning',
      'weekly',
      'monthly',
    ]) {
      expect(scheduleOf(token)).toEqual({ kind: 'simple', expr: token })
    }
  })

  // The wire wants whole seconds written as a decimal string. Nobody should have to find
  // that out, so every interval form lands on the same string.
  it('turns every interval form into whole seconds written as a string', () => {
    expect(scheduleOf({ every: '5m' })).toEqual({ kind: 'interval', expr: '300' })
    expect(scheduleOf({ every: 300 })).toEqual({ kind: 'interval', expr: '300' })
    expect(scheduleOf('5m')).toEqual({ kind: 'interval', expr: '300' })
    expect(scheduleOf({ every: '2h' })).toEqual({ kind: 'interval', expr: '7200' })
    expect(scheduleOf({ every: '1d' })).toEqual({ kind: 'interval', expr: '86400' })
    expect(scheduleOf({ every: '90s' })).toEqual({ kind: 'interval', expr: '90' })
  })

  it('takes the explicit forms too, so a token that also reads as something else can be pinned', () => {
    expect(scheduleOf({ cron: '@daily' })).toEqual({ kind: 'cron', expr: '@daily' })
    expect(scheduleOf({ simple: 'daily' })).toEqual({ kind: 'simple', expr: 'daily' })
    expect(scheduleOf({ interval: '10m' })).toEqual({ kind: 'interval', expr: '600' })
  })

  it('refuses an interval outside the bounds the service holds, naming both of them', () => {
    const tooShort = refusal({ name: 'a-job', schedule: { every: '10s' }, channels: 'none' })

    expect(tooShort).toContain('30')
    expect(tooShort).toContain('31622400')

    expect(refusal({ name: 'a-job', schedule: { every: '400d' }, channels: 'none' })).toContain(
      '31622400',
    )
  })

  it('refuses a fractional interval rather than rounding one nobody asked it to round', () => {
    expect(refusal({ name: 'a-job', schedule: { every: 90.5 }, channels: 'none' })).toContain(
      'whole',
    )
  })
})

describe('the cron dialect a scheduler and this service disagree about', () => {
  it('refuses a six-field expression and names the dialect it came from', () => {
    const message = refusal({ name: 'a-job', schedule: '*/5 * * * * *', channels: 'none' })

    expect(message).toContain('six')
    expect(message).toContain('seconds')
    expect(message).toMatch(/croner|node-cron/)
  })

  it('refuses fewer than five fields as the typo it is, not as a dialect problem', () => {
    const message = refusal({ name: 'a-job', schedule: '0 3 * *', channels: 'none' })

    expect(message).toContain('five')
    expect(message).not.toContain('seconds')
  })

  it('refuses @reboot, which means nothing to a service that never sees the machine start', () => {
    const message = refusal({ name: 'a-job', schedule: '@reboot', channels: 'none' })

    expect(message).toContain('@reboot')
    expect(message).toContain('@daily')
  })

  it('refuses a single word that is neither a token nor a duration, and says what it could be', () => {
    const message = refusal({ name: 'a-job', schedule: 'dayly', channels: 'none' })

    expect(message).toContain('dayly')
    expect(message).toContain('daily')
  })
})

describe('a name is how sync identifies a monitor, and nothing on the service enforces one', () => {
  it('refuses two monitors sharing a name before a credential is needed or a request exists', () => {
    let caught: unknown

    try {
      defineMonitors([
        { name: 'nightly-backup', schedule: '@daily', channels: 'none' },
        { name: 'nightly-backup', schedule: '@hourly', channels: 'none' },
      ])
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SyncConfigurationError)
    expect((caught as Error).message).toContain('nightly-backup')
    expect((caught as Error).message).toContain('2')
  })

  it('refuses two names that would claim the same environment variable', () => {
    let message = ''

    try {
      defineMonitors([
        { name: 'nightly-backup', schedule: '@daily', channels: 'none' },
        { name: 'nightly backup', schedule: '@daily', channels: 'none' },
      ])
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('CRONHEART_NIGHTLY_BACKUP_UUID')
  })

  it('refuses a name the service would refuse, rather than sending it', () => {
    expect(refusal({ name: 'a', schedule: '@daily', channels: 'none' })).toContain('2')
    expect(refusal({ name: 'x'.repeat(121), schedule: '@daily', channels: 'none' })).toContain('120')
  })
})

describe('what a configuration says about channels', () => {
  it('reads silence as leaving the routing alone, never as replacing it', () => {
    expect(first({ name: 'a-job', schedule: '@daily' }).routing).toEqual({ mode: 'unmanaged' })
  })

  it('reads the word none as the only way to say a monitor alerts nobody', () => {
    expect(first({ name: 'a-job', schedule: '@daily', channels: 'none' }).routing).toEqual({
      mode: 'none',
    })
  })

  // The shape a defaulted value takes — channels: ids ?? [] — and the one that would blank a
  // monitor's routing without anyone writing it down.
  it('refuses an empty list rather than reading it as the word none', () => {
    const message = refusal({ name: 'a-job', schedule: '@daily', channels: [] })

    expect(message).toContain("'none'")
    expect(message).toContain('empty')
  })

  it('keeps the references a configuration listed, without deciding what they mean yet', () => {
    expect(first({ name: 'a-job', schedule: '@daily', channels: ['ops inbox', 7] }).routing).toEqual({
      mode: 'listed',
      references: ['ops inbox', 7],
    })
  })

  it('refuses a word it does not know rather than reading it as a label', () => {
    expect(refusal({ name: 'a-job', schedule: '@daily', channels: 'all' as 'none' })).toContain(
      'all',
    )
  })
})

describe('the fields a configuration does not state', () => {
  it('leaves them out, so nothing sync sends can change a value nobody wrote down', () => {
    const defined = first({ name: 'a-job', schedule: '@daily', channels: 'none' })

    expect(defined.tz).toBeUndefined()
    expect(defined.graceSeconds).toBeUndefined()
  })

  it('refuses a zone name the service cannot construct, naming the field', () => {
    expect(
      refusal({ name: 'a-job', schedule: '@daily', channels: 'none', tz: 'Mars/Olympus' }),
    ).toContain('tz')
  })

  it('refuses a grace outside the bounds the service holds', () => {
    expect(
      refusal({ name: 'a-job', schedule: '@daily', channels: 'none', graceSeconds: 86401 }),
    ).toContain('86400')
  })
})

describe('the shapes a configuration file can take', () => {
  it('takes a bare array and an object carrying one, and reads them the same way', () => {
    const fromArray = defineMonitors([{ name: 'a-job', schedule: '@daily', channels: 'none' }])
    const fromObject = defineMonitors({
      monitors: [{ name: 'a-job', schedule: '@daily', channels: 'none' }],
    })

    expect(fromObject.monitors).toEqual(fromArray.monitors)
  })

  it('refuses anything else rather than reconciling against an empty set', () => {
    expect(() => defineMonitors(undefined as unknown as [])).toThrow(SyncConfigurationError)
    expect(() => defineMonitors({ monitors: 'nightly-backup' } as unknown as [])).toThrow(
      SyncConfigurationError,
    )
  })
})
