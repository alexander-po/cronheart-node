import { describe, expect, it } from 'vitest'
import { defineMonitors } from '../src/sync/define.js'
import { quoted } from '../src/sync/errors.js'
import { planSync } from '../src/sync/plan.js'
import { renderPlan } from '../src/sync/render.js'
import { describeSchedule } from '../src/sync/schedule.js'
import { channelRow, createMonitorStore, monitorRow } from './support/monitor-store.js'
import { apiFor } from './support/sync-api.js'

const IDENTIFIER = '00000000-0000-0000-0000-000000000001'

const UNPRINTABLE = [
  ['a left-to-right mark', '\u200E', 'U+200E'],
  ['a right-to-left mark', '\u200F', 'U+200F'],
  ['an arabic letter mark', '\u061C', 'U+061C'],
  ['a zero-width space', '\u200B', 'U+200B'],
  ['a byte order mark', '\uFEFF', 'U+FEFF'],
  ['a tag character', '\u{E0041}', 'U+E0041'],
  ['a right-to-left override', '\u202E', 'U+202E'],
  ['a bell', '\u0007', 'U+0007'],
] as const

describe('what a refusal or a plan prints of text the caller supplied', () => {
  it('prints a value that is an identifier cut, as a monitor name is', () => {
    expect(quoted(IDENTIFIER)).toBe('"id…0001"')
    expect(quoted(IDENTIFIER.replaceAll('-', ''))).toBe('"id…0001"')
    expect(quoted(`\u200E${IDENTIFIER}`)).toBe('"id…0001"')
  })

  it.each([
    ['a leading space', ` ${IDENTIFIER}`],
    ['a crontab line', `0 4 * * * curl https://example.invalid/ping/${IDENTIFIER}`],
    ['a ping address', `https://example.invalid/ping/${IDENTIFIER}`],
    ['braces', `{${IDENTIFIER}}`],
    ['a bare form after an escaped character', `ping \u200E${IDENTIFIER.replaceAll('-', '')}`],
    ['a joiner inside it', `00000000-\u200D0000-0000-0000-000000000001`],
    ['a code point inside it', `00000000-\u200E0000-0000-0000-000000000001`],
  ])('cuts an identifier held in %s', (_what, text) => {
    expect(quoted(text)).not.toContain(IDENTIFIER)
    expect(quoted(text)).toContain('id…0001')
  })

  it('cuts a monitor name that opens with a space in the whole refusal', () => {
    let message = ''

    try {
      defineMonitors([{ name: ` ${IDENTIFIER}`, schedule: 'nonsense here' } as never])
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('is not a cron expression')
    expect(message).not.toContain(IDENTIFIER)
  })

  it('leaves ordinary text whole', () => {
    expect(quoted('ops inbox')).toBe('"ops inbox"')
    expect(quoted('')).toBe('""')
  })

  it.each(UNPRINTABLE)('spells out %s', (_what, character, name) => {
    const printed = quoted(`a${character}b`)

    expect(printed).toBe(`"a<${name}>b"`)
  })

  it.each(UNPRINTABLE)('spells out %s in a schedule read from the service', (_what, character, name) => {
    expect(describeSchedule('cron', `0${character}4 * * *`)).toBe(`cron 0<${name}>4 * * *`)
  })

  it('never lets an identifier given as a channel reference reach the plan', async () => {
    const store = createMonitorStore([monitorRow()], [channelRow({ id: '7', label: 'ops inbox', verified: true })])
    const plan = await planSync(apiFor(store), [{ name: 'a-job', schedule: '@daily', channels: [IDENTIFIER] }])
    const printed = renderPlan(plan)

    expect(printed).toContain('id…0001')
    expect(printed).not.toContain(IDENTIFIER)
  })

  it('writes a tab in a schedule between delimiters, so it cannot read as part of a number', () => {
    expect(describeSchedule('cron', '0\t4 * * *')).toBe('cron 0<U+0009>4 * * *')
  })

  it.each([
    ['00A0', true], ['1680', true], ['167F', false], ['2000', true], ['200B', true],
    ['200C', false], ['200D', false], ['200E', true], ['200F', true], ['2010', false], ['202F', true],
    ['205F', true], ['2060', true], ['2064', true], ['2065', false], ['3000', true], ['3001', false],
    ['061C', true], ['061B', false], ['FEFF', true], ['FEFE', false], ['E0000', true], ['E007F', true],
    ['E0080', false], ['DFFFF', false],
  ] as const)('spells out U+%s: %s', (hex, spelled) => {
    const character = String.fromCodePoint(Number.parseInt(hex, 16))

    expect(quoted(`a${character}b`)).toBe(spelled ? `"a<U+${hex}>b"` : JSON.stringify(`a${character}b`))
  })

  it('prints the schedule the service holds with its code points spelled out', async () => {
    const store = createMonitorStore(
      [monitorRow({ schedule_expr: '0\u20284 * * *', grace_seconds: 60, tz: 'UTC' })],
      [channelRow({ id: '7', label: 'ops inbox', verified: true })],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 5 * * *', channels: ['ops inbox'] },
    ])
    const printed = renderPlan(plan)

    expect(printed).toContain('U+2028')
    expect(printed).not.toContain('\u2028')
  })
})
