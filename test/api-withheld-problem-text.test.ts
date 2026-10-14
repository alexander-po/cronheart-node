import { describe, expect, it } from 'vitest'
import { createCronheartApi } from '../src/api/client.js'
import type { CronheartApi } from '../src/api/types.js'
import {
  API_KEY,
  BASE_URL,
  CHANNEL_ID,
  EVERY_CALL,
  MONITOR_UUID,
  type RecordedRequest,
  apiWith,
} from './support/api-recorder.js'
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

const UUID_ROUTES = [
  'monitors.alerts',
  'monitors.delete',
  'monitors.get',
  'monitors.iterateAlerts',
  'monitors.iteratePings',
  'monitors.pause',
  'monitors.pings',
  'monitors.resume',
  'monitors.rotateUuid',
  'monitors.snooze',
  'monitors.unsnooze',
  'monitors.update',
]

const UUID_SPELLINGS = [MONITOR_UUID, MONITOR_UUID.replaceAll('-', ''), `https://ping.example/ping/${MONITOR_UUID}`]

const OPEN_ROUTES = EVERY_CALL.map((call) => call.id).filter(
  (id) => !UUID_ROUTES.includes(id) && !id.startsWith('channels.') && id !== 'rateLimit',
)

function carriedBy(request: RecordedRequest): string[] {
  const body: unknown = request.body === undefined ? {} : JSON.parse(request.body)

  return [...Object.keys(body as object), ...new URL(request.url).searchParams.keys()].sort()
}

function echoingTheUuid(status: number, request: RecordedRequest) {
  const spelled = UUID_SPELLINGS.join(' / ')

  return {
    status,
    json: {
      type: 'about:blank',
      title: `Refused ${spelled}`,
      status,
      detail: `The monitor ${spelled} refused this.`,
      upgrade_url: `https://example.invalid/upgrade?for=${spelled}`,
      errors: {
        ...Object.fromEntries(carriedBy(request).map((field) => [field, `${spelled} is not valid.`])),
        ...Object.fromEntries(UUID_SPELLINGS.map((spelling) => [spelling, 'This value is not valid.'])),
        [`name.${MONITOR_UUID}`]: 'This value is not valid.',
        kind: 'A field no monitor request carries.',
      },
    },
  }
}

function callNamed(id: string) {
  const call = EVERY_CALL.find((candidate) => candidate.id === id)

  if (call === undefined) {
    throw new Error(`${id} is not in the route registry`)
  }

  return call
}

describe('the service’s own wording on a route that names a monitor', () => {
  it('finds the uuid in the request of exactly these routes, in its address or its body', async () => {
    const carrying: string[] = []

    for (const call of EVERY_CALL) {
      const { api, recorder } = apiWith({ status: 404, json: { status: 404 } })

      await call.run(api).catch(() => undefined)

      if (recorder.requests.some((request) => `${request.url} ${request.body ?? ''}`.includes(MONITOR_UUID))) {
        carrying.push(call.id)
      }
    }

    expect(carrying.sort()).toEqual(UUID_ROUTES)
  })

  it.each(OPEN_ROUTES)('is kept on %s, which names no monitor', async (id) => {
    const { api } = apiWith({ status: 422, json: { title: 'Refused', detail: 'Kept as the service wrote it.' } })

    const failure = await callNamed(id).run(api).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toMatchObject({ problem: { title: 'Refused', detail: 'Kept as the service wrote it.' } })
  })

  it.each(UUID_ROUTES.flatMap((id) => [402, 404, 409, 422, 500].map((status) => [id, status] as const)))(
    'is withheld on %s answering %i with an echo of the uuid',
    async (id, status) => {
      const { api, recorder } = apiWith((request) => echoingTheUuid(status, request))

      const failure = await callNamed(id).run(api).then(
        () => undefined,
        (error: unknown) => error,
      )
      const request = recorder.requests[0] as RecordedRequest
      const problem = (failure as { problem?: { errors?: Record<string, string> } }).problem

      expect(failure).toBeInstanceOf(Error)
      expect(request.url).toContain(MONITOR_UUID)
      expect((failure as Error).message).toContain('/monitors/{uuid}')

      for (const surface of surfacesOf(failure)) {
        for (const spelling of UUID_SPELLINGS) {
          expect(surface).not.toContain(spelling)
        }
      }

      expect(Object.keys(problem?.errors ?? {}).sort()).toEqual(carriedBy(request))
      expect(new Set(Object.values(problem?.errors ?? {})).size).toBeLessThanOrEqual(1)
    },
  )

  it('keeps an item of a field the request carries, and no index long enough to carry a value', async () => {
    const { api } = apiWith({
      status: 422,
      json: {
        status: 422,
        errors: {
          'channel_ids[0]': 'Unknown channel.',
          'channel_ids.1': 'Unknown channel.',
          'channel_ids[00000000000000000000000000000000]': 'Unknown channel.',
          [`channel_ids.${'0'.repeat(32)}`]: 'Unknown channel.',
          'channel_ids.123456': 'Unknown channel.',
          'channel_ids[123456]': 'Unknown channel.',
          'channel_ids.1234567': 'Unknown channel.',
          'channel_ids[1234567]': 'Unknown channel.',
        },
      },
    })

    const failure = await api.monitors.update(MONITOR_UUID, { channelIds: [CHANNEL_ID, CHANNEL_ID] }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(Object.keys((failure as { errors: Record<string, string> }).errors).sort()).toEqual([
      'channel_ids.1',
      'channel_ids.123456',
      'channel_ids[0]',
      'channel_ids[123456]',
    ])
  })

  it.each([
    [
      'an update that sets every field',
      (api: CronheartApi) =>
        api.monitors.update(MONITOR_UUID, {
          name: 'renamed',
          scheduleKind: 'cron',
          scheduleExpr: '0 3 * * *',
          tz: 'UTC',
          graceSeconds: 60,
          channelIds: [CHANNEL_ID],
        }),
    ],
    ['a page of pings after a cursor', (api: CronheartApi) => api.monitors.pings(MONITOR_UUID, { limit: 5, cursor: 'b3BhcXVl' })],
  ])('keeps the name of every field in %s', async (_what, call) => {
    const { api, recorder } = apiWith((request) => echoingTheUuid(422, request))

    const failure = await call(api).then(
      () => undefined,
      (error: unknown) => error,
    )
    const carried = carriedBy(recorder.requests[0] as RecordedRequest)

    expect(carried.length).toBeGreaterThan(1)
    expect(Object.keys((failure as { errors: Record<string, string> }).errors).sort()).toEqual(carried)
  })
})

const HEX_RUN = `${'0'.repeat(31)}3`

const LETTERED = ['f'.repeat(8), 'e'.repeat(4), 'd'.repeat(4), 'c'.repeat(4), 'b'.repeat(12)].join('-')

const IDENTIFIER_SHAPED = [
  ['a hyphenated id', '00000000-0000-0000-0000-000000000001'],
  ['a hyphenated id in upper case', LETTERED.toUpperCase()],
  ['a hyphenated id in lower case', LETTERED],
  ['a bare run of 32 hex digits', HEX_RUN],
  ['a bare run of 32 hex digits in mixed case', `${'aB'.repeat(8)}${'0'.repeat(16)}`],
  ['an id after an underscore', `monitor_${MONITOR_UUID}`],
  ['an id before an underscore', `${HEX_RUN}_x`],
  ['an id after a letter that is not hex', `g${HEX_RUN}`],
  ['a hyphenated id after another hex digit', 'a00000000-0000-0000-0000-000000000002'],
  ['a hyphenated id before another hex digit', '00000000-0000-0000-0000-0000000000003'],
  ['a hyphenated id after a percent-escaped solidus', `%2F${LETTERED}`],
  ['a hyphenated id after a percent-escaped equals sign', '%3D00000000-0000-0000-0000-000000000001'],
] as const

const NOT_IDENTIFIER_SHAPED = [
  ['36 characters grouped 8-4-4-4-12 that are not hex', ['g'.repeat(8), 'h'.repeat(4), 'i'.repeat(4), 'j'.repeat(4), 'k'.repeat(12)].join('-')],
  ['a run of 64 hex digits', `${'0'.repeat(63)}2`],
  ['32 hex digits after another hex digit', `f${HEX_RUN}`],
  ['32 hex digits before another hex digit', `${HEX_RUN}a`],
  ['32 hex digits after a percent-escaped solidus', `%2F${HEX_RUN}`],
] as const

const POSITIONS = ['title', 'detail', 'upgrade_url', 'an errors key', 'an errors message'] as const

type Position = (typeof POSITIONS)[number]

interface Kept {
  readonly title: string | undefined
  readonly detail: string | undefined
  readonly upgradeUrl: string | undefined
  readonly errors: Readonly<Record<string, string>> | undefined
}

const PLAIN: Kept = {
  title: 'Refused',
  detail: 'Kept as the service wrote it.',
  upgradeUrl: 'https://example.invalid/upgrade',
  errors: { name: 'Too short.', schedule_expr: 'Not a schedule.' },
}

function carrying(text: string, position: Position): Kept {
  switch (position) {
    case 'title':
      return { ...PLAIN, title: `Refused ${text}` }
    case 'detail':
      return { ...PLAIN, detail: `The monitor ${text} was refused.` }
    case 'upgrade_url':
      return { ...PLAIN, upgradeUrl: `https://example.invalid/upgrade?for=${text}` }
    case 'an errors key':
      return { ...PLAIN, errors: { ...PLAIN.errors, [`channel_ids.${text}`]: 'Unknown channel.' } }
    case 'an errors message':
      return { ...PLAIN, errors: { ...PLAIN.errors, name: `${text} is too short.` } }
  }
}

function withoutIt(position: Position): Kept {
  switch (position) {
    case 'title':
      return { ...PLAIN, title: undefined }
    case 'detail':
      return { ...PLAIN, detail: undefined }
    case 'upgrade_url':
      return { ...PLAIN, upgradeUrl: undefined }
    case 'an errors key':
      return PLAIN
    case 'an errors message':
      return { ...PLAIN, errors: { schedule_expr: 'Not a schedule.' } }
  }
}

function answering(status: number, held: Kept) {
  return {
    status,
    json: { type: 'about:blank', status, title: held.title, detail: held.detail, upgrade_url: held.upgradeUrl, errors: held.errors },
  }
}

async function failureOn(id: string, status: number, held: Kept): Promise<Error & { problem: Kept }> {
  const { api } = apiWith(answering(status, held))
  const failure = await callNamed(id).run(api).then(
    () => undefined,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)

  return failure as Error & { problem: Kept }
}

function keptOf(failure: { problem: Kept }): Kept {
  const { title, detail, upgradeUrl, errors } = failure.problem

  return { title, detail, upgradeUrl, errors }
}

const OPEN_CASES = OPEN_ROUTES.flatMap((id) =>
  [402, 403, 409, 422, 429, 500].flatMap((status) => POSITIONS.map((position) => [id, status, position] as const)),
)

describe('identifier-shaped text on a route that sends no id', () => {
  it('is checked on exactly the routes that send no id and are not channel routes', () => {
    expect([...OPEN_ROUTES].sort()).toEqual(['account.get', 'monitors.create', 'monitors.iterate', 'monitors.list'])
  })

  it.each(OPEN_CASES)('drops the field on %s answering %i with an id in %s, and keeps the rest', async (id, status, position) => {
    for (const [, text] of IDENTIFIER_SHAPED) {
      const failure = await failureOn(id, status, carrying(text, position))

      expect(keptOf(failure)).toEqual(withoutIt(position))
      expect(failure.stack ?? '').not.toContain(text)

      for (const surface of surfacesOf(failure)) {
        expect(surface).not.toContain(text)
      }
    }
  })

  it.each(OPEN_CASES)('keeps the field on %s answering %i with text in %s that is not an id', async (id, status, position) => {
    for (const [, text] of NOT_IDENTIFIER_SHAPED) {
      const held = carrying(text, position)
      const failure = await failureOn(id, status, held)

      expect(keptOf(failure)).toEqual(held)
    }
  })

  it.each(IDENTIFIER_SHAPED)('recognises %s', async (_what, text) => {
    const failure = await failureOn('monitors.create', 422, carrying(text, 'detail'))

    expect(failure.problem.detail).toBeUndefined()
  })

  it.each(NOT_IDENTIFIER_SHAPED)('does not recognise %s', async (_what, text) => {
    const failure = await failureOn('monitors.create', 422, carrying(text, 'detail'))

    expect(failure.problem.detail).toBe(`The monitor ${text} was refused.`)
  })

  it('reads the errors on the error itself the same way as on its problem', async () => {
    const failure = await failureOn('monitors.create', 422, carrying(HEX_RUN, 'an errors message'))

    expect((failure as unknown as { errors: unknown }).errors).toEqual({ schedule_expr: 'Not a schedule.' })
    expect(failure.message).toContain('schedule_expr')
    expect(failure.message).not.toContain(HEX_RUN)
  })

  it.each(['%2F', '%3D'])('drops an upgrade address that carries a hyphenated id after %s', async (escape) => {
    const failure = await failureOn('account.get', 402, { ...PLAIN, upgradeUrl: `https://example.invalid/upgrade?for${escape}${MONITOR_UUID}` })

    expect(keptOf(failure)).toEqual({ ...PLAIN, upgradeUrl: undefined })
  })

  it('reads the upgrade address on the error itself the same way as on its problem', async () => {
    const failure = await failureOn('monitors.create', 402, carrying(LETTERED, 'upgrade_url'))

    expect((failure as unknown as { upgradeUrl?: unknown }).upgradeUrl).toBeUndefined()
    expect(failure.problem.title).toBe('Refused')
  })
})
