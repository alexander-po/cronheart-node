import { describe, expect, it } from 'vitest'
import { createCronheartApi } from '../src/api/client.js'
import {
  ApiConfigurationError,
  ApiInvalidRequestError,
  isCronheartApiError,
} from '../src/api/errors.js'
import { createSession } from '../src/api/http.js'
import { MAX_RETRIES } from '../src/constants.js'
import { attemptsFor } from '../src/transport/attempts.js'
import type {
  CreateChannelRequest,
  CronheartApi,
  CronheartApiOptions,
} from '../src/api/types.js'
import {
  ALERT_JSON,
  API_KEY,
  BASE_URL,
  CHANNEL_ID,
  CHANNEL_JSON,
  MONITOR_JSON,
  PING_JSON,
  MONITOR_UUID,
  apiWith,
  createApiRecorder,
  streamingFetch,
} from './support/api-recorder.js'
import {
  CHANNEL_KINDS,
  REQUIRED_FIELDS,
  channelRequest,
  fillerFor,
  optionNameOf,
  requiredBy,
} from './support/channel-requirements.js'
import { API_RESPONSE_BODY_CAP_BYTES } from '../src/api/constants.js'
import { ApiTransportError } from '../src/api/errors.js'
import type { FetchLike, PingHttpResponse } from '../src/ping/types.js'

const CREATE = {
  name: 'nightly-backup',
  scheduleKind: 'cron',
  scheduleExpr: '0 3 * * *',
} as const

const UNREACHABLE = { rejectWith: new Error('socket hang up') }

// A header value that ends the header and starts one of its own. The second Authorization
// is what a request carrying the account's key would then also carry.
const INJECTION = 'job-1\r\nAuthorization: Bearer cmk_someone-elses-key'

function surfacesOf(error: unknown): string[] {
  return [
    String(error),
    error instanceof Error ? error.message : '',
    JSON.stringify(error) ?? '',
    Object.entries(error as object)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' '),
  ]
}

// Stated here rather than derived from the cap the client reads: a bound taken from that
// constant holds however far it moves, and a body twice the cap classifies the same either
// way, so the bytes pulled are the only thing that tells a capped read from an uncapped one.
const MANAGEMENT_READ_CEILING_BYTES = 5 * 1024 * 1024

describe('an answer larger than this client reads', () => {
  it('reports the client as the one that stopped, not the service as having answered badly', async () => {
    const oversized = streamingFetch(
      new Uint8Array(API_RESPONSE_BODY_CAP_BYTES * 2).fill(0x78),
      65536,
    )
    const { api } = apiWith({}, { fetch: oversized.fetch })

    const refusal = await api.monitors.list().catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ApiTransportError)
    expect((refusal as ApiTransportError).reason).toBe('unbounded')
    expect((refusal as ApiTransportError).message).toContain('stops reading')
    expect(oversized.pulledBytes()).toBeLessThan(MANAGEMENT_READ_CEILING_BYTES)
  })

  it('holds a body its transport can only hand over whole to the same cap', async () => {
    const page = JSON.stringify({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
      padding: 'x'.repeat(5 * 1024 * 1024),
    })
    const wholeOnly: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(page),
      })
    const { api } = apiWith({}, { fetch: wholeOnly })

    const refusal = await api.monitors.list().catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ApiTransportError)
    expect((refusal as ApiTransportError).reason).toBe('unbounded')
  })

  // The other side of the same boundary: what the client read whole is the service's answer
  // to account for, and saying otherwise sends a support request at the wrong party.
  it('reports a body it read whole as unparseable rather than as one it cut short', async () => {
    const undersized = streamingFetch(
      new Uint8Array(API_RESPONSE_BODY_CAP_BYTES - 1024).fill(0x78),
      65536,
    )
    const { api } = apiWith({}, { fetch: undersized.fetch })

    const refusal = await api.monitors.list().catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ApiTransportError)
    expect((refusal as ApiTransportError).reason).toBe('unparseable')
  })
})

describe('the retry cap', () => {
  it.each([
    ['configured on the client', { retries: 40 }],
    ['read out of the environment', { env: { CRONHEART_RETRIES: '40' }, retries: undefined }],
  ])('is not something a retry count can talk its way past, %s', async (_id, overrides) => {
    const { api, recorder } = apiWith(UNREACHABLE, {
      timeoutMs: 5000,
      ...(overrides as CronheartApiOptions),
    })

    await api.monitors.list().catch(() => undefined)

    expect(recorder.requests).toHaveLength(MAX_RETRIES + 1)
  })

  it('is the same number the check-in transport is held to', () => {
    expect(attemptsFor(40)).toBe(MAX_RETRIES + 1)
    expect(attemptsFor(0)).toBe(1)
    expect(attemptsFor(-3)).toBe(1)
  })
})

describe('the idempotency key', () => {
  it.each(['', '   ', undefined])(
    'counts as absent when it is blank, so a retry cannot create a second monitor: %j',
    async (idempotencyKey) => {
      const { api, recorder } = apiWith(UNREACHABLE, { retries: 3 })

      await api.monitors.create(CREATE, { idempotencyKey }).catch(() => undefined)

      expect(recorder.requests).toHaveLength(1)
      expect(recorder.requests[0]?.headers).not.toHaveProperty('Idempotency-Key')
    },
  )

  it('still turns retries on when it carries something the service can store', async () => {
    const { api, recorder } = apiWith(UNREACHABLE, { retries: 1 })

    await api.monitors.create(CREATE, { idempotencyKey: 'nightly-2026-08-20' }).catch(() => undefined)

    expect(recorder.requests).toHaveLength(2)
  })

  it.each([
    ['carries a line break that would inject a header of its own', INJECTION],
    ['carries a bare newline', 'job-1\nX-Injected: 1'],
    ['is not a string at all', 42 as unknown as string],
    ['is longer than the service can store', 'k'.repeat(256)],
  ])('is refused before a request exists when it %s', async (_id, idempotencyKey) => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await expect(api.monitors.create(CREATE, { idempotencyKey })).rejects.toBeInstanceOf(
      ApiInvalidRequestError,
    )
    await expect(
      api.channels.create({ kind: 'email', label: 'ops inbox', address: 'ops@example.invalid' }, { idempotencyKey }),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    expect(recorder.requests).toHaveLength(0)
  })
})

describe('the user agent', () => {
  it.each([
    ['a line break that would inject a header of its own', INJECTION],
    ['a value that is not a string', 42 as unknown as string],
    ['nothing at all', ''],
  ])('is refused at wiring time when it carries %s', (_id, userAgent) => {
    expect(() =>
      createCronheartApi({ apiKey: API_KEY, baseUrl: BASE_URL, env: {}, userAgent }),
    ).toThrow(ApiConfigurationError)
  })

  it('is still the caller’s own when it is a header value the service can read', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON }, { userAgent: 'deploy-bot/2.1' })

    await api.monitors.get(MONITOR_UUID)

    expect(recorder.requests[0]?.headers['User-Agent']).toBe('deploy-bot/2.1')
  })
})

describe('what the caller hands the client', () => {
  it.each([
    ['a schedule kind on a create', (api: CronheartApi) => api.monitors.create({ ...CREATE, scheduleKind: 'crontab' })],
    ['a schedule kind on an update', (api: CronheartApi) => api.monitors.update(MONITOR_UUID, { scheduleKind: 'crontab' })],
    ['a channel kind', (api: CronheartApi) => api.channels.create({ kind: 'carrier-pigeon', label: 'ops inbox' })],
  ])('refuses %s the service does not have, before a request exists', async (_id, call) => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await expect(call(api)).rejects.toBeInstanceOf(ApiInvalidRequestError)
    expect(recorder.requests).toHaveLength(0)
  })

  it('sends a destination field the kind does not take, as it sends any field it was given', async () => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    await api.channels.create({
      kind: 'slack',
      label: 'ops room',
      webhookUrl: 'https://example.invalid/slack',
      routingKey: 'a'.repeat(32),
    })

    expect(JSON.parse(String(recorder.requests[0]?.body))).toEqual({
      kind: 'slack',
      label: 'ops room',
      webhook_url: 'https://example.invalid/slack',
      routing_key: 'a'.repeat(32),
    })
  })

  it('still sends the destination fields the caller did give as strings', async () => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    await api.channels.create({ kind: 'webhook', label: 'ops hook', webhookUrl: 'https://hooks.example/x', secret: 'sh' })

    expect(JSON.parse(String(recorder.requests[0]?.body))).toMatchObject({
      kind: 'webhook',
      label: 'ops hook',
      webhook_url: 'https://hooks.example/x',
      secret: 'sh',
    })
  })

  it('cannot break the seal with a body no encoder could serialise', async () => {
    const recorder = createApiRecorder({ status: 200, json: {} })
    const session = createSession({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 1000,
      attempts: attemptsFor(0),
      userAgent: 'cronheart-node/test',
      fetch: recorder.fetch,
      signal: undefined,
    })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular

    for (const body of [{ big: 1n }, circular, { toJSON: () => { throw new TypeError('boom') } }]) {
      const failure = await session
        .send({ method: 'POST', path: '/monitors', retry: 'never', body }, undefined)
        .then(() => undefined)
        .catch((error: unknown) => error)

      expect(isCronheartApiError(failure)).toBe(true)
    }

    expect(recorder.requests).toHaveLength(0)
  })
})

describe('the options the client is built from', () => {
  it('refuses a base URL that is not a string rather than coercing one out of it', () => {
    for (const baseUrl of [42, true, ['https://api.example'], { toString: () => BASE_URL }]) {
      expect(() =>
        createCronheartApi({ apiKey: API_KEY, baseUrl: baseUrl as unknown as string, env: {} }),
      ).toThrow(ApiConfigurationError)
    }
  })

  it.each(['apiKey', 'baseUrl', 'timeoutMs', 'retries', 'userAgent', 'fetch', 'signal', 'env'])(
    'keeps a throwing %s getter inside the one type a caller catches',
    (member) => {
      const options: Record<string, unknown> = { apiKey: API_KEY, baseUrl: BASE_URL, env: {} }
      Object.defineProperty(options, member, {
        enumerable: true,
        get: () => {
          throw new TypeError(`the ${member} the caller passed in exploded`)
        },
      })

      const failure = (() => {
        try {
          createCronheartApi(options as CronheartApiOptions)

          return undefined
        } catch (error) {
          return error
        }
      })()

      expect(isCronheartApiError(failure)).toBe(true)
    },
  )
})

describe('a failure names the route without naming the monitor', () => {
  it.each([
    ['get', (api: ReturnType<typeof createCronheartApi>) => api.monitors.get(MONITOR_UUID)],
    ['pause', (api: ReturnType<typeof createCronheartApi>) => api.monitors.pause(MONITOR_UUID)],
    ['pings', (api: ReturnType<typeof createCronheartApi>) => api.monitors.pings(MONITOR_UUID)],
    ['alerts', (api: ReturnType<typeof createCronheartApi>) => api.monitors.alerts(MONITOR_UUID)],
  ])('on monitors.%s', async (_id, call) => {
    const { api, recorder } = apiWith({ status: 404, json: { status: 404 } })
    const failure = await call(api).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeDefined()

    for (const surface of surfacesOf(failure)) {
      expect(surface).not.toContain(MONITOR_UUID)
    }

    expect((failure as Error).message).toContain('/api/v1/monitors/{uuid}')
    expect(recorder.requests[0]?.url).toContain(MONITOR_UUID)
  })
})

describe('what this client refuses before a guaranteed rejection reaches the wire', () => {
  it('refuses a timezone the runtime cannot name, and says which field it is', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await expect(
      api.monitors.create({
        name: 'nightly-backup',
        scheduleKind: 'cron',
        scheduleExpr: '0 3 * * *',
        tz: 'Mars/Olympus_Mons',
      }),
    ).rejects.toThrow(/tz/)
    expect(recorder.requests).toHaveLength(0)
  })

  it('sends a timezone the runtime does know', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.create({
      name: 'nightly-backup',
      scheduleKind: 'cron',
      scheduleExpr: '0 3 * * *',
      tz: 'America/New_York',
    })

    expect(recorder.requests).toHaveLength(1)
  })

  // Z is what an ISO timestamp spells UTC as, and no zone database carries it under that
  // name — so it is taken and sent as the name that reads back identical on the next run.
  it('sends Z as UTC, and a fixed offset exactly as it was written', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })
    const base = { name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' } as const

    await api.monitors.create({ ...base, tz: 'Z' })
    await api.monitors.create({ ...base, tz: '+05:00' })

    expect(recorder.requests.map((request) => JSON.parse(String(request.body))['tz'])).toEqual([
      'UTC',
      '+05:00',
    ])
  })

  it('counts a name the way the service counts it, in characters and not in code units', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })
    const create = (name: string) =>
      api.monitors.create({ name, scheduleKind: 'cron', scheduleExpr: '0 3 * * *' })

    // One character to the service; two code units here. The bound is 2 characters.
    await expect(create('\u{1F600}')).rejects.toThrow(/characters/)

    await create('\u{1F600}'.repeat(120))

    expect(recorder.requests).toHaveLength(1)
  })

  it('refuses a fractional value where the service states a whole number', async () => {
    const { api } = apiWith({ json: { ...MONITOR_JSON, grace_seconds: 60.5 } })

    await expect(api.monitors.get(MONITOR_UUID)).rejects.toThrow(/grace_seconds/)
  })

  it('hands back a rate-limit reading that survives being destructured off the client', async () => {
    const { api } = apiWith({
      json: MONITOR_JSON,
      headers: { 'x-ratelimit-limit': '120', 'x-ratelimit-remaining': '7' },
    })
    const { monitors, rateLimit } = api

    await monitors.get(MONITOR_UUID)

    expect(rateLimit()).toEqual({ limit: 120, remaining: 7, resetAt: undefined })
  })
})

const REQUIREMENTS = [...REQUIRED_FIELDS].flatMap(([field, kinds]) =>
  kinds.map((kind) => [kind, field] as const),
)

const NON_STRINGS = [12345, 12345n, ['12345'], { toJSON: () => '12345' }]

describe('a channel create, for every field the contract says a kind requires', () => {
  it('covers every channel kind the contract knows, from a set that is not empty', () => {
    expect(REQUIREMENTS.length).toBeGreaterThan(0)
    expect([...new Set(REQUIREMENTS.map(([kind]) => kind))].sort()).toEqual([...CHANNEL_KINDS].sort())
  })

  it.each(REQUIREMENTS)('refuses a %s channel without %s, naming it', async (kind, field) => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    const refusal = await api.channels.create(channelRequest(kind, field)).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ApiInvalidRequestError)
    expect((refusal as Error).message).toContain(optionNameOf(field))
    expect(recorder.requests).toHaveLength(0)
  })

  it.each(REQUIREMENTS)('sends a %s channel its %s under the wire key', async (kind, field) => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    await api.channels.create(channelRequest(kind, field, fillerFor(field)))

    expect(JSON.parse(String(recorder.requests[0]?.body))).toEqual({
      kind,
      label: 'ops room',
      ...Object.fromEntries(requiredBy(kind).map((wireKey) => [wireKey, fillerFor(wireKey)])),
    })
  })

  it.each(REQUIREMENTS)('refuses a %s channel whose %s is not a string, without repeating it', async (kind, field) => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    for (const value of NON_STRINGS) {
      const refusal = await api.channels
        .create(channelRequest(kind, field, value))
        .catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(ApiInvalidRequestError)
      expect((refusal as Error).message).toContain(optionNameOf(field))
      expect((refusal as Error).message).not.toContain('12345')
    }

    expect(recorder.requests).toHaveLength(0)
  })
})

const MONITOR_REQUEST = {
  name: 'nightly-backup',
  scheduleKind: 'cron',
  scheduleExpr: '0 3 * * *',
  tz: 'UTC',
  graceSeconds: 60,
  channelIds: ['1'],
} as const

const CHANNEL_REQUEST = {
  kind: 'webhook',
  label: 'ops sink',
  ...Object.fromEntries(
    [...REQUIRED_FIELDS.keys()].map((wireKey) => [optionNameOf(wireKey), fillerFor(wireKey)]),
  ),
} as CreateChannelRequest

const MONITOR_WIRE_KEYS: Readonly<Record<string, string>> = {
  name: 'name',
  scheduleKind: 'schedule_kind',
  scheduleExpr: 'schedule_expr',
  tz: 'tz',
  graceSeconds: 'grace_seconds',
  channelIds: 'channel_ids',
}

type Call = (api: CronheartApi, request: object, options: object) => Promise<unknown>

const REQUESTS: readonly (readonly [string, object, Call, Readonly<Record<string, string>>])[] = [
  ['monitors.create', MONITOR_REQUEST, (api, request, options) => api.monitors.create(request as never, options), MONITOR_WIRE_KEYS],
  ['monitors.update', MONITOR_REQUEST, (api, request, options) => api.monitors.update(MONITOR_UUID, request, options), MONITOR_WIRE_KEYS],
  [
    'channels.create',
    CHANNEL_REQUEST,
    (api, request, options) => api.channels.create(request as never, options),
    Object.fromEntries(Object.keys(CHANNEL_REQUEST).map((field) => [field, field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)])),
  ],
]

const REQUEST_FIELDS = REQUESTS.flatMap(([route, base, call, wireKeys]) =>
  Object.keys(base).map((field) => [route, field, base, call, wireKeys[field] as string] as const),
)

function withAccessor<T extends object>(base: T, field: string, get: () => unknown): T {
  const copy = { ...base }
  Object.defineProperty(copy, field, { enumerable: true, configurable: true, get })

  return copy
}

function exploding(field: string): () => never {
  return () => {
    throw new TypeError(`the ${field} the caller passed in exploded`)
  }
}

function answerFor(route: string) {
  return route.startsWith('channels.') ? { status: 201, json: CHANNEL_JSON } : { json: MONITOR_JSON }
}

const OPTION_TRAP = new TypeError('an option the caller passed in exploded')

function trap(): never {
  throw OPTION_TRAP
}

const HOSTILE_OPTIONS = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })

const LEADING_ARGS: Readonly<Record<string, readonly unknown[]>> = {
  'monitors.create': [MONITOR_REQUEST],
  'monitors.update': [MONITOR_UUID, MONITOR_REQUEST],
  'monitors.snooze': [MONITOR_UUID, '1h'],
  'channels.create': [CHANNEL_REQUEST],
  'channels.rename': [CHANNEL_ID, 'ops room'],
}

const IDENTIFIER_OF: Readonly<Record<string, unknown>> = { monitors: MONITOR_UUID, channels: CHANNEL_ID }

function leadingArgsFor(group: string, method: string, arity: number): readonly unknown[] {
  return LEADING_ARGS[`${group}.${method}`] ?? Array.from({ length: arity - 1 }, () => IDENTIFIER_OF[group])
}

const REFLECTED = createCronheartApi({ apiKey: API_KEY, baseUrl: BASE_URL, env: {} })

const OPTION_CASES = Object.entries(REFLECTED)
  .filter(([, member]) => typeof member === 'object' && member !== null)
  .flatMap(([group, members]) => Object.keys(members as object).map((method) => [group, method] as const))

type Method = (...args: unknown[]) => unknown

function methodOf(api: CronheartApi, group: string, method: string): Method {
  const found = (api as unknown as Record<string, Record<string, Method>>)[group]?.[method]

  if (found === undefined) {
    throw new Error(`${group}.${method} is gone`)
  }

  return found
}

function invoke(api: CronheartApi, group: string, method: string, options: object) {
  const call = methodOf(api, group, method)
  const returned = call(...leadingArgsFor(group, method, call.length), options) as {
    next?: () => Promise<unknown>
  }
  const iterator = typeof returned.next === 'function'

  return { iterator, settled: Promise.resolve(iterator ? returned.next?.() : returned) }
}

const ITERATORS = OPTION_CASES.filter(([group, method]) => {
  const { iterator, settled } = invoke(apiWith({}).api, group, method, {})
  settled.catch(() => undefined)

  return iterator
})

const TWO_PAGES: Readonly<Record<string, readonly unknown[]>> = {
  'monitors.iterate': [
    { data: [{ ...MONITOR_JSON, uuid: '00000000-0000-0000-0000-000000000001' }], total: 2, limit: 1, offset: 0 },
    { data: [{ ...MONITOR_JSON, uuid: '00000000-0000-0000-0000-000000000002' }], total: 2, limit: 1, offset: 1 },
  ],
  'monitors.iterateAlerts': [
    { data: [ALERT_JSON], total: 2, limit: 1, offset: 0 },
    { data: [{ ...ALERT_JSON, id: '78' }], total: 2, limit: 1, offset: 1 },
  ],
  'monitors.iteratePings': [
    { data: [PING_JSON], next_cursor: 'b3BhcXVl' },
    { data: [{ ...PING_JSON, id: '2' }], next_cursor: null },
  ],
}

const OPTION_KEYS = ['limit', 'offset', 'cursor', 'timeoutMs', 'signal', 'idempotencyKey']

function counting(values: Readonly<Record<string, unknown>>) {
  const reads: Record<string, number> = {}
  const count = (key: PropertyKey) => {
    reads[String(key)] = (reads[String(key)] ?? 0) + 1
  }
  const options = new Proxy(
    { ...Object.fromEntries(OPTION_KEYS.map((key) => [key, undefined])), ...values },
    {
      get: (target, key) => {
        count(key)

        return Reflect.get(target, key)
      },
      getOwnPropertyDescriptor: (target, key) => {
        count(key)

        return Reflect.getOwnPropertyDescriptor(target, key)
      },
      ownKeys: (target) => {
        count('[[OwnPropertyKeys]]')

        return Reflect.ownKeys(target)
      },
    },
  )

  return { options, reads }
}

describe('composing a request out of what the caller hands in', () => {
  it.each(REQUEST_FIELDS)('keeps a throwing %s %s getter inside the one type a caller catches', async (route, field, base, call) => {
    const { api, recorder } = apiWith(answerFor(route))

    const failure = await call(api, withAccessor(base, field, exploding(field)), {}).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ApiInvalidRequestError)
    expect(failure).not.toHaveProperty('cause')
    expect(recorder.requests).toHaveLength(0)
  })

  it.each(OPTION_CASES)('keeps %s.%s inside the one type a caller catches when every option it reads throws', async (group, method) => {
    const { api, recorder } = apiWith(answerFor(`${group}.${method}`))

    const failure = await invoke(api, group, method, HOSTILE_OPTIONS).settled.catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ApiInvalidRequestError)
    expect((failure as Error).message).toContain('could not be composed')
    expect(failure).not.toHaveProperty('cause')
    expect(recorder.requests).toHaveLength(0)
  })

  it.each(OPTION_CASES)('reads every option %s.%s uses once', async (group, method) => {
    const { api } = apiWith(answerFor(`${group}.${method}`))
    const { options, reads } = counting({})

    await invoke(api, group, method, options).settled.catch(() => undefined)

    expect(Object.keys(reads)).toEqual(expect.arrayContaining(['timeoutMs', 'signal']))
    expect(Object.entries(reads).filter(([, count]) => count !== 1)).toEqual([])
  })

  it('finds a two-page answer for every iterator the client has', () => {
    expect(ITERATORS.length).toBeGreaterThan(0)
    expect(ITERATORS.map(([group, method]) => `${group}.${method}`).sort()).toEqual(
      Object.keys(TWO_PAGES).sort(),
    )
  })

  it.each(ITERATORS)('reads every option of %s.%s once across a two-page walk', async (group, method) => {
    const pages = TWO_PAGES[`${group}.${method}`] ?? []
    const { api, recorder } = apiWith((_request, attempt) => ({
      json: pages[Math.min(attempt, pages.length) - 1],
    }))
    const { options, reads } = counting({ limit: 1, timeoutMs: 5000 })
    const call = methodOf(api, group, method)
    const walked: unknown[] = []

    for await (const item of call(...leadingArgsFor(group, method, call.length), options) as AsyncIterable<unknown>) {
      walked.push(item)
    }

    expect(recorder.requests).toHaveLength(2)
    expect(walked).toHaveLength(2)
    expect(Object.keys(reads)).toEqual(expect.arrayContaining(['limit', 'timeoutMs', 'signal']))
    expect(Object.entries(reads).filter(([, count]) => count !== 1)).toEqual([])
  })

  it.each([
    ['an object whose toString throws', { toString: () => { throw new TypeError('toString ran') } }],
    ['an object whose Symbol.toPrimitive throws', { [Symbol.toPrimitive]: () => { throw new TypeError('toPrimitive ran') } }],
    ['a symbol', Symbol('cursor')],
  ])('refuses a cursor that is %s, before a request exists', async (_id, cursor) => {
    const options = { cursor: cursor as unknown as string }

    for (const call of [
      (api: CronheartApi) => api.monitors.pings(MONITOR_UUID, options),
      (api: CronheartApi) => api.monitors.iteratePings(MONITOR_UUID, options).next(),
    ]) {
      const { api, recorder } = apiWith({ json: { data: [], next_cursor: null } })

      await expect(call(api)).rejects.toBeInstanceOf(ApiInvalidRequestError)
      expect(recorder.requests).toHaveLength(0)
    }
  })

  it.each(REQUESTS.filter(([route]) => route.startsWith('monitors.')))(
    'sends a full %s request under exactly the wire keys it knows',
    async (route, base, call, wireKeys) => {
      const { api, recorder } = apiWith(answerFor(route))

      await call(api, base, {})

      expect(Object.keys(JSON.parse(String(recorder.requests[0]?.body))).sort()).toEqual(
        Object.values(wireKeys).sort(),
      )
    },
  )

  it.each([
    ['an own map', () => Object.assign(['1'], { map: () => { throw new TypeError('an own map ran') } })],
    ['a subclass with its own toJSON', () => {
      class Ids extends Array<string> {
        toJSON() {
          return ['999']
        }
      }
      const ids = new Ids()
      ids.push('1')

      return ids
    }],
  ] as const)('sends channel ids held in an array with %s as the plain ids it holds', async (_id, channelIds) => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.create({ ...MONITOR_REQUEST, channelIds: channelIds() })

    expect(JSON.parse(String(recorder.requests[0]?.body))['channel_ids']).toEqual(['1'])
  })

  it('refuses channel ids with a hole in them rather than sending one', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })
    const holed = new Array<string>(2)
    holed[1] = '1'

    await expect(api.monitors.create({ ...MONITOR_REQUEST, channelIds: holed })).rejects.toBeInstanceOf(
      ApiInvalidRequestError,
    )
    expect(recorder.requests).toHaveLength(0)
  })

  it.each(REQUEST_FIELDS)('reads the %s %s once, and sends the value it validated', async (route, field, base, call, wireKey) => {
    const { api, recorder } = apiWith(answerFor(route))
    const valid = (base as Record<string, unknown>)[field]
    let reads = 0

    await call(api, withAccessor(base, field, () => (reads++ === 0 ? valid : Symbol('changed'))), {})

    expect(reads).toBe(1)
    expect(JSON.parse(String(recorder.requests[0]?.body))[wireKey]).toEqual(valid)
  })

  it.each([
    ['monitors.create', (api: CronheartApi, options: object) => api.monitors.create(MONITOR_REQUEST, options)],
    ['channels.create', (api: CronheartApi, options: object) => api.channels.create(CHANNEL_REQUEST, options)],
  ] as const)('reads the %s idempotency key once, and sends the value it validated', async (route, call) => {
    const { api, recorder } = apiWith(answerFor(route))
    let reads = 0

    await call(api, withAccessor({}, 'idempotencyKey', () => (reads++ === 0 ? 'job-1' : 'job\r\n2')))

    expect(reads).toBe(1)
    expect(recorder.requests[0]?.headers['Idempotency-Key']).toBe('job-1')
  })
})
