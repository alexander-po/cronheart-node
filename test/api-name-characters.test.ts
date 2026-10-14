import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NAME_FORBIDDEN_RANGES } from '../src/api.js'
import { NAME_FORBIDDEN_RANGES as ANCHORED_RANGES } from '../src/contract-anchors.js'
import type { CronheartApi } from '../src/api/types.js'
import { idFlagRefusal, nameFlagRefusal } from '../src/cli/client.js'
import { defineMonitors } from '../src/sync/define.js'
import { SyncConfigurationError } from '../src/sync/errors.js'
import { describeApiRefusal } from '../src/sync/refusal.js'
import type { MonitorDefinition } from '../src/sync/types.js'
import { CHANNEL_ID, CHANNEL_JSON, MONITOR_JSON, MONITOR_UUID, apiWith } from './support/api-recorder.js'

function codePointName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

const REFUSED_EDGES = [0x0000, 0x001f, 0x007f, 0x009f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069]

const ACCEPTED_EDGES = [0x0020, 0x007e, 0x00a0, 0x2027, 0x202f, 0x2065, 0x206a]

const ACCEPTED_ON_PURPOSE = [
  ['a lone high surrogate', '\uD800'],
  ['a lone low surrogate', '\uDC00'],
  ['the Arabic letter mark', '\u061C'],
  ['the left-to-right mark', '\u200E'],
  ['the right-to-left mark', '\u200F'],
  ['a byte order mark', '\uFEFF'],
  ['a deprecated format character', '\u206F'],
  ['accented letters', 'é'],
  ['an emoji', '\u{1F642}'],
  ['CJK text', '夜間'],
] as const

const POSITIONS = [
  ['first', (character: string) => `${character}nightly`],
  ['in the middle', (character: string) => `night${character}ly`],
  ['last', (character: string) => `nightly${character}`],
] as const

type Send = (api: CronheartApi, value: unknown) => Promise<unknown>

const FIELDS: readonly (readonly [string, string, Send])[] = [
  ['monitors.create', 'name', (api, name) => api.monitors.create({ name: name as string, scheduleKind: 'cron', scheduleExpr: '0 3 * * *' })],
  ['monitors.update', 'name', (api, name) => api.monitors.update(MONITOR_UUID, { name: name as string })],
  ['channels.create', 'label', (api, label) => api.channels.create({ kind: 'email', label: label as string, address: 'ops@example.invalid' })],
  ['channels.rename', 'label', (api, label) => api.channels.rename(CHANNEL_ID, label as string)],
]

async function refusalOf(send: Send, value: unknown): Promise<{ message: string; sent: number }> {
  const { api, recorder } = apiWith((request) => ({
    json: request.url.includes('/channels') ? CHANNEL_JSON : MONITOR_JSON,
  }))
  const failure = await send(api, value).then(
    () => undefined,
    (error: unknown) => error,
  )

  return {
    message: failure === undefined ? '' : (failure as { kind?: string }).kind === 'invalid-request' ? (failure as Error).message : `not refused here: ${String(failure)}`,
    sent: recorder.requests.length,
  }
}

const REFUSED_CASES = FIELDS.flatMap(([route, field, send]) =>
  REFUSED_EDGES.flatMap((codePoint) =>
    POSITIONS.map(([where, place]) => [route, codePointName(codePoint), where, field, send, place(String.fromCodePoint(codePoint))] as const),
  ),
)

describe('the characters a name or a label may not hold', () => {
  it.each(REFUSED_CASES)('%s refuses %s %s, naming the field and the code point and never the value', async (_route, named, _where, field, send, value) => {
    const refused = await refusalOf(send, value)

    expect(refused.sent).toBe(0)
    expect(refused.message).toContain(field)
    expect(refused.message).toContain(named)
    expect(refused.message).not.toContain('night')
    expect(refused.message).not.toContain(String.fromCodePoint(Number.parseInt(named.slice(2), 16)))
  })

  it.each(
    FIELDS.flatMap(([route, , send]) => [
      ...ACCEPTED_EDGES.map((codePoint) => [route, codePointName(codePoint), send, `night${String.fromCodePoint(codePoint)}ly`] as const),
      ...ACCEPTED_ON_PURPOSE.map(([what, character]) => [route, what, send, `night${character}ly`] as const),
    ]),
  )('%s sends a name holding %s', async (_route, _what, send, value) => {
    const refused = await refusalOf(send, value)

    expect(refused.message).toBe('')
    expect(refused.sent).toBe(1)
  })

  it.each([
    ['two line breaks', '\n\n', 'U+000A'],
    ['one bell', '\u0007', 'U+0007'],
    ['a bell in a name past the length bound', `${'x'.repeat(120)}\u0007`, 'U+0007'],
  ])('reports %s as the character it holds, before its blankness or its length', async (_what, value, named) => {
    for (const [, , send] of FIELDS) {
      const refused = await refusalOf(send, value)

      expect(refused.message).toContain(named)
      expect(refused.message).not.toMatch(/non-empty|between/)
    }
  })

  it('refuses a value of spaces as blank, since a space is not a character it refuses', async () => {
    for (const [, field, send] of FIELDS) {
      const refused = await refusalOf(send, '    ')

      expect(refused.message).toBe(`${field} must be a non-empty string.`)
    }
  })

  it.each([
    ['a number', 42],
    ['a String object', new String('nightly-backup')],
    ['a String object holding a line break', new String('nightly\nbackup')],
  ])('refuses %s as not a string before reading its characters', async (_what, value) => {
    for (const [, field, send] of FIELDS) {
      const refused = await refusalOf(send, value)

      expect(refused.message).toBe(`${field} must be a non-empty string.`)
    }
  })

  it('leaves a schedule expression and a zone to their own rules', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.create({ name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0\t3\t*\t*\t*' })
    await api.monitors.update(MONITOR_UUID, { scheduleKind: 'cron', scheduleExpr: '0 3 * * *\n' })

    expect(recorder.requests).toHaveLength(2)

    const zone = await refusalOf((given, tz) => given.monitors.update(MONITOR_UUID, { tz: tz as string }), 'UTC\u2028')

    expect(zone.sent).toBe(0)
    expect(zone.message).toMatch(/^tz /)
    expect(zone.message).not.toContain('U+2028')
  })

  it('names the first character it refuses when a value holds several', async () => {
    const refused = await refusalOf(FIELDS[0]?.[2] as Send, 'night\u202Ely\u0007')

    expect(refused.message).toContain('U+202E')
    expect(refused.message).not.toContain('U+0007')
  })

  it('is the set the contract states for both fields, read through the anchors', () => {
    const contract = JSON.parse(readFileSync(new URL('../contract/cronheart-contract.json', import.meta.url), 'utf8')) as {
      api: { constraints: Record<string, { forbidden_ranges?: unknown }> }
      anchors: { id: string; pointer: string }[]
    }
    const anchored = contract.anchors.filter((anchor) => anchor.pointer.endsWith('/forbidden_ranges'))

    expect(anchored.map((anchor) => anchor.pointer).sort()).toEqual([
      '/api/constraints/channel.label/forbidden_ranges',
      '/api/constraints/monitor.name/forbidden_ranges',
    ])
    expect(contract.api.constraints['monitor.name']?.forbidden_ranges).toEqual(ANCHORED_RANGES)
    expect(contract.api.constraints['channel.label']?.forbidden_ranges).toEqual(ANCHORED_RANGES)
    expect(NAME_FORBIDDEN_RANGES).toBe(ANCHORED_RANGES)
  })
})

function refusalOfAll(definitions: readonly MonitorDefinition[]): SyncConfigurationError {
  try {
    defineMonitors(definitions)
  } catch (error) {
    if (error instanceof SyncConfigurationError) {
      return error
    }

    throw error
  }

  throw new Error('the configuration was accepted')
}

function syncRefusal(name: string, schedule = '@daily'): SyncConfigurationError {
  return refusalOfAll([{ name, schedule, channels: 'none' }])
}

const LETTERED_ID = ['a'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), `${'0'.repeat(11)}a`].join('-')

function screamed(id: string): string {
  return `CRONHEART_${id.toUpperCase().replaceAll('-', '_')}_UUID`
}

describe('a refused name in a configuration', () => {
  it.each(REFUSED_EDGES.map((codePoint) => [codePointName(codePoint), String.fromCodePoint(codePoint)] as const))(
    'is labelled with %s spelled out rather than written raw',
    (named, character) => {
      const refused = syncRefusal(`night${character}ly`)
      const label = `night${named}ly`

      expect(refused.monitor).toBe(label)
      expect(refused.message.startsWith(`"${label}": name holds ${named}.`)).toBe(true)
      expect(refused.message).not.toContain(character)
    },
  )

  it.each([
    ['a whole id', '00000000-0000-0000-0000-000000000001', 'id\u20260001'],
    ['an id with a refused character after it', '00000000-0000-0000-0000-000000000002\u2028', 'id\u20260002'],
    ['an id after a line feed', '\n00000000-0000-0000-0000-000000000003', 'id\u20260003'],
    ['an id after a direction override', '\u202E00000000-0000-0000-0000-000000000001', 'id\u20260001'],
  ])('is labelled by the last four characters of %s, as every other message names one', (_what, name, label) => {
    const refused = syncRefusal(name, 'not a schedule')

    expect(refused.monitor).toBe(label)
    expect(refused.message.startsWith(`"${label}": `)).toBe(true)
    expect(refused.message).not.toContain(name.replace(/[^0-9a-f-]/g, ''))
  })

  it('names two monitors of one id-shaped name by its last four characters', () => {
    const id = '00000000-0000-0000-0000-000000000001'
    const refused = refusalOfAll([
      { name: id, schedule: '@daily', channels: 'none' },
      { name: id, schedule: '@hourly', channels: 'none' },
    ])

    expect(refused.message).toContain('2 monitors named "id\u20260001"')
    expect(refused.message).not.toContain(id)
    expect(refused.message).not.toContain(screamed(id))
  })

  it('names an id and its upper-case twin by their last four characters, and not the variable both scream', () => {
    const refused = refusalOfAll([
      { name: LETTERED_ID, schedule: '@daily', channels: 'none' },
      { name: LETTERED_ID.toUpperCase(), schedule: '@hourly', channels: 'none' },
    ])

    expect(refused.message.startsWith('"id\u2026000a" and "id\u2026000A" both resolve to one environment variable')).toBe(true)

    for (const spelled of [LETTERED_ID, LETTERED_ID.toUpperCase(), screamed(LETTERED_ID), LETTERED_ID.replaceAll('-', '_').toUpperCase()]) {
      expect(refused.message).not.toContain(spelled)
    }
  })

  it('still names the variable two plain names both resolve to', () => {
    const refused = refusalOfAll([
      { name: 'nightly backup', schedule: '@daily', channels: 'none' },
      { name: 'nightly-backup', schedule: '@hourly', channels: 'none' },
    ])

    expect(refused.message).toBe('"nightly backup" and "nightly-backup" both resolve to CRONHEART_NIGHTLY_BACKUP_UUID, so only one of them could ever be addressed by name.')
  })
})

describe('what the command line echoes back of a refused flag', () => {
  it.each([
    ['an escape sequence in --uuid', () => idFlagRefusal('\u001b[31mred'), '--uuid=U+001B[31mred is not a monitor id'],
    ['a direction override in an id-shaped --uuid', () => idFlagRefusal('00000000-0000-0000-0000-00000000000\u202E'), '--uuid=id\u2026000U+202E is not a monitor id'],
    ['a direction override in an id-shaped --name', () => nameFlagRefusal('00000000-0000-0000-0000-0000000000\u202E1'), '--name=id\u202600U+202E1 reads as a monitor id'],
    ['an escape sequence in an id-shaped --name', () => nameFlagRefusal('00000000-0000-0000-0000-0000000000\u001b1'), '--name=id\u202600U+001B1 reads as a monitor id'],
  ])('spells out %s', (_what, refuse, opening) => {
    const message = refuse() ?? ''

    expect(message.startsWith(opening)).toBe(true)
    expect(message).not.toMatch(/[\u0000-\u001f\u202e]/)
  })
})

describe('the fields a sync refusal repeats from the service', () => {
  it('lists only plain field names, never one holding a line separator or a line feed', async () => {
    const { api } = apiWith({
      status: 422,
      json: { status: 422, errors: { name: 'Too short.', 'tz\u2028forged': 'x', 'grace\nforged': 'x' } },
    })
    const failure = await api.monitors.create({ name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(describeApiRefusal(failure, 'creating it')).toBe('the service refused this request over name.')
  })
})
