import { describe, expect, it } from 'vitest'
import { createCronheartApi } from '../src/api/client.js'
import type { CronheartApi } from '../src/api/types.js'
import { API_KEY, BASE_URL, CHANNEL_ID, apiWith } from './support/api-recorder.js'
import {
  REQUIRED_FIELDS,
  channelRequest,
  kindRequiring,
  letterOf,
} from './support/channel-requirements.js'

// Three shapes per destination field: two a field-name rule would let through as a key, and
// one it would not.
function valuesFor(wireKey: string): readonly string[] {
  const letter = letterOf(wireKey)
  const digit = String([...REQUIRED_FIELDS.keys()].indexOf(wireKey) + 1)

  return [letter.repeat(32), `-100${digit.repeat(10)}`, `https://example.invalid/${letter.repeat(24)}`]
}

// Every spelling the service's prose could plausibly hand a value back in, one of them with
// the solidus escaped the way a JSON encoder that escapes it writes a URL into a message.
function spellingsOf(wireKey: string): readonly string[] {
  const letter = letterOf(wireKey)
  const digit = String([...REQUIRED_FIELDS.keys()].indexOf(wireKey) + 1)

  return [
    ...new Set(
      valuesFor(wireKey).flatMap((value) => [
        value,
        value.toUpperCase(),
        value.toLowerCase(),
        encodeURIComponent(value),
        JSON.stringify(value).slice(1, -1).replaceAll('/', '\\/'),
      ]),
    ),
    letter.repeat(12),
    digit.repeat(8),
  ]
}

function echoing(status: number, wireKey: string) {
  const spellings = spellingsOf(wireKey)
  const spelled = spellings.join(' / ')

  return {
    status,
    json: {
      type: 'about:blank',
      title: `Refused ${spelled}`,
      status,
      detail: `The destination ${spelled} was refused.`,
      upgrade_url: `https://example.invalid/upgrade?for=${spelled}`,
      errors: {
        [wireKey]: `${spelled} is not valid.`,
        label: `Shown next to ${spelled}.`,
        ...Object.fromEntries(spellings.map((spelling) => [spelling, 'This value is not valid.'])),
      },
    },
  }
}

function stringsReachableFrom(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return []
  }

  seen.add(value)

  return Reflect.ownKeys(value).flatMap((key) => [
    String(key),
    ...stringsReachableFrom((value as Record<PropertyKey, unknown>)[key], seen),
  ])
}

function surfacesOf(error: unknown): string[] {
  return [
    String(error),
    error instanceof Error ? error.message : '',
    JSON.stringify(error) ?? '',
    ...stringsReachableFrom(error),
  ]
}

type ChannelMethod = (...args: unknown[]) => Promise<unknown>

const METHODS = Object.keys(createCronheartApi({ apiKey: API_KEY, baseUrl: BASE_URL, env: {} }).channels)

function callOn(api: CronheartApi, method: string, wireKey: string): Promise<unknown> {
  const call = (api.channels as unknown as Record<string, ChannelMethod>)[method]

  if (call === undefined) {
    throw new Error(`api.channels.${method} is gone`)
  }

  const kind = kindRequiring(wireKey)

  return method === 'create'
    ? call(channelRequest(kind, wireKey, valuesFor(wireKey)[0]))
    : call(...Array.from({ length: call.length - 1 }, () => CHANNEL_ID))
}

const CASES = METHODS.flatMap((method) =>
  [402, 409, 422, 502].flatMap((status) =>
    [...REQUIRED_FIELDS.keys()].map((wireKey) => [method, status, wireKey] as const),
  ),
)

describe('the service’s own wording on a channel route', () => {
  it('is read off every channel method the client has, and every destination field the contract names', () => {
    expect(METHODS).toEqual(expect.arrayContaining(['create', 'test']))
    expect(REQUIRED_FIELDS.size).toBeGreaterThan(0)
  })

  it.each(CASES)('is withheld on channels.%s answering %i with an echo of %s', async (method, status, wireKey) => {
    const { api } = apiWith(echoing(status, wireKey))

    const failure = await callOn(api, method, wireKey).then(
      () => undefined,
      (error: unknown) => error,
    )
    const problem = (failure as { problem?: { errors?: Record<string, string> } }).problem

    expect(failure).toBeInstanceOf(Error)

    for (const surface of surfacesOf(failure)) {
      for (const spelling of spellingsOf(wireKey)) {
        expect(surface).not.toContain(spelling)
      }
    }

    expect(Object.keys(problem?.errors ?? {}).sort()).toEqual([wireKey, 'label'].sort())
    expect(new Set(Object.values(problem?.errors ?? {})).size).toBe(1)

    if (status === 422) {
      expect((failure as Error).message).toContain(wireKey)
    }
  })

  it('is still kept on a route that carries no destination', async () => {
    const { api } = apiWith({
      status: 422,
      json: { title: 'Refused', detail: 'The name is too short.', errors: { name: 'Too short.' } },
    })

    const failure = await api.monitors
      .create({ name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' })
      .then(
        () => undefined,
        (error: unknown) => error,
      )

    expect(failure).toMatchObject({
      problem: { title: 'Refused', detail: 'The name is too short.', errors: { name: 'Too short.' } },
    })
  })
})
