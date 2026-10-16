import { describe, expect, it } from 'vitest'
import { codePointName, withForbiddenRemoved, withForbiddenSpelledOut } from '../src/api/validate.js'
import { defineMonitors } from '../src/sync/define.js'
import { quoted } from '../src/sync/errors.js'
import { monitorLabel } from '../src/sync/label.js'
import { planSync } from '../src/sync/plan.js'
import { envLinesFor, renderPlan } from '../src/sync/render.js'
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
    ['205F', true], ['2060', true], ['2064', true], ['2065', true], ['3000', true], ['3001', false],
    ['061C', true], ['061B', false], ['FEFF', true], ['FEFE', false], ['E0000', true], ['E007F', true],
    ['E0080', true], ['E0FFF', true], ['E1000', false], ['DFFFF', false],
    ['00AD', true], ['034F', true], ['180B', true], ['180F', true], ['206A', true], ['206F', true], ['3164', true],
    ['FE00', true], ['FE0D', true], ['FFA0', true], ['FFF9', true], ['FFFB', true], ['2800', true], ['1D173', true],
    ['0020', false], ['200C', false], ['200D', false], ['FE0E', false], ['FE0F', false], ['0600', false],
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

const READABLE = new Set([0x20, 0x200c, 0x200d, 0xfe0e, 0xfe0f])

describe('the characters spelled out are the ones Unicode marks as ignorable or as a space', () => {
  it('spells out every default-ignorable code point and every space separator but the readable ones', () => {
    const unspelled: string[] = []
    let checked = 0

    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint)

      if (/[\p{Default_Ignorable_Code_Point}\p{Zs}]/u.test(character) && !READABLE.has(codePoint)) {
        checked += 1

        if (withForbiddenSpelledOut(character) !== codePointName(codePoint)) {
          unspelled.push(codePointName(codePoint))
        }
      }
    }

    expect(checked).toBeGreaterThan(4000)
    expect(unspelled).toEqual([])
  })

  it('removes the readable invisible characters when it looks for an identifier, though it prints them', () => {
    expect(withForbiddenRemoved(`a\uFE0Fb\u200Dc`)).toBe('abc')
    expect(withForbiddenSpelledOut('a\uFE0Fb\u200Dc')).toBe('a\uFE0Fb\u200Dc')
  })

  it.each(['\u00AD', '\u3164', '\uFFA0', '\uFE00', '\uFE0F', '\u2065', '\uFFF9', '\u2800'])(
    'still cuts an identifier that sits behind %j',
    (character) => {
      expect(quoted(`${character}${IDENTIFIER}`)).toBe('"id…0001"')
      expect(quoted(`ping ${character}${IDENTIFIER}`)).toBe('"ping id…0001"')
    },
  )
})

describe('what sync prints of values the service returned', () => {
  const ZERO_WIDTH = '\u200B'

  it('spells out and cuts what the plan shows of a zone, a channel kind and a channel label', async () => {
    const store = createMonitorStore(
      [monitorRow({ tz: `UTC${ZERO_WIDTH}`, channel_ids: ['7', '8'] })],
      [
        channelRow({ id: '7', kind: `email${ZERO_WIDTH}`, label: 'ops inbox', verified: true }),
        channelRow({ id: '8', label: IDENTIFIER, verified: true }),
      ],
    )
    const plan = await planSync(apiFor(store), [{ name: 'nightly-backup', schedule: '0 3 * * *', tz: 'Europe/Berlin' }])
    const printed = renderPlan(plan)

    expect(printed).not.toContain(ZERO_WIDTH)
    expect(printed).toContain('UTC' + 'U+200B')
    expect(printed).toContain('email' + 'U+200B')
    expect(printed).not.toContain(IDENTIFIER)
    expect(printed).toContain('id…0001')
  })

  it('keeps every label of a routing change readable, whatever the first one opens with', async () => {
    const store = createMonitorStore(
      [monitorRow({ channel_ids: ['7', '8'] })],
      [
        channelRow({ id: '7', label: '20261016-oncall', verified: true }),
        channelRow({ id: '8', label: 'ops inbox', verified: true }),
        channelRow({ id: '9', label: 'ceo pager', verified: true }),
      ],
    )
    const plan = await planSync(apiFor(store), [{ name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ceo pager'] }])
    const line = renderPlan(plan).split('\n').find((row) => row.includes('channels')) ?? ''

    expect(line).toContain('20261016-oncall')
    expect(line).toContain('ops inbox')
    expect(line).toContain('ceo pager')
  })

  it('cuts a channel label that is an identifier where the plan says nobody would be alerted', async () => {
    const store = createMonitorStore(
      [],
      [channelRow({ id: '7', label: IDENTIFIER, verified: false })],
    )
    const plan = await planSync(apiFor(store), [{ name: 'new-one', schedule: '@daily', channels: ['7'] }])
    const printed = renderPlan(plan)

    expect(printed).toContain('would alert nobody')
    expect(printed).not.toContain(IDENTIFIER)
  })

  it('cuts an identifier held in a schedule the service returned', () => {
    expect(describeSchedule('cron', `0 4 * * * ${IDENTIFIER}`)).toBe('cron 0 4 * * * id…0001')
  })

  it('cuts a monitor name that holds an identifier anywhere in it', () => {
    expect(monitorLabel(`backup ${IDENTIFIER}`)).toBe('backup id…0001')
    expect(monitorLabel('backup nightly')).toBe('backup nightly')
  })

  it('spells out a schedule kind the service returned', () => {
    expect(describeSchedule(`cron${ZERO_WIDTH}`, '0 4 * * *')).toBe('cron<U+200B> 0 4 * * *')
  })

  it('cuts an identifier held inside a zone', async () => {
    const store = createMonitorStore([monitorRow({ tz: `UTC ${IDENTIFIER}` })], [channelRow({ id: '7', verified: true })])
    const plan = await planSync(apiFor(store), [{ name: 'nightly-backup', schedule: '0 3 * * *', tz: 'UTC' }])

    expect(renderPlan(plan)).not.toContain(IDENTIFIER)
  })
})

describe('what --print-env may write into a file the shell reads back', () => {
  it('writes a line for an identifier and for nothing else the service returned', () => {
    const lines = envLinesFor([
      { name: 'good-one', uuid: IDENTIFIER },
      { name: 'newline', uuid: `${IDENTIFIER}\nCRONHEART_OTHER_UUID=${IDENTIFIER}` },
      { name: 'padded', uuid: ` ${IDENTIFIER}` },
      { name: 'empty', uuid: '' },
    ])

    expect(lines).toEqual([`CRONHEART_GOOD_ONE_UUID=${IDENTIFIER}`])
  })
})
