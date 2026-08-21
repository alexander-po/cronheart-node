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
import type { CronheartApi, CronheartApiOptions } from '../src/api/types.js'
import {
  API_KEY,
  BASE_URL,
  CHANNEL_JSON,
  MONITOR_JSON,
  MONITOR_UUID,
  apiWith,
  createApiRecorder,
  streamingFetch,
} from './support/api-recorder.js'
import { API_RESPONSE_BODY_CAP_BYTES } from '../src/api/constants.js'
import { ApiTransportError } from '../src/api/errors.js'

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
    ['a channel address', { kind: 'email', label: 'ops inbox', address: 1n }],
    ['a chat id', { kind: 'telegram', label: 'ops room', chatId: { toJSON: () => ({}) } }],
    ['a webhook url', { kind: 'webhook', label: 'ops hook', webhookUrl: 42 }],
    ['a webhook secret', { kind: 'webhook', label: 'ops hook', secret: ['s'] }],
  ])('is refused rather than encoded when %s is not a string', async (_id, request) => {
    const { api, recorder } = apiWith({ status: 201, json: CHANNEL_JSON })

    await expect(
      api.channels.create(request as unknown as Parameters<typeof api.channels.create>[0]),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    expect(recorder.requests).toHaveLength(0)
  })

  it.each([
    ['a schedule kind on a create', (api: CronheartApi) => api.monitors.create({ ...CREATE, scheduleKind: 'crontab' })],
    ['a schedule kind on an update', (api: CronheartApi) => api.monitors.update(MONITOR_UUID, { scheduleKind: 'crontab' })],
    ['a channel kind', (api: CronheartApi) => api.channels.create({ kind: 'carrier-pigeon', label: 'ops inbox' })],
  ])('refuses %s the service does not have, before a request exists', async (_id, call) => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await expect(call(api)).rejects.toBeInstanceOf(ApiInvalidRequestError)
    expect(recorder.requests).toHaveLength(0)
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

  it.each([
    ['email', { kind: 'email', label: 'ops inbox' }, /address/],
    ['telegram', { kind: 'telegram', label: 'ops chat' }, /chatId/],
    ['slack', { kind: 'slack', label: 'ops room' }, /webhookUrl/],
    ['discord', { kind: 'discord', label: 'ops room' }, /webhookUrl/],
    [
      'webhook',
      { kind: 'webhook', label: 'ops sink', webhookUrl: 'https://sink.example/hook' },
      /secret/,
    ],
  ] as const)('refuses a %s channel that is missing the field that kind needs', async (
    _kind,
    request,
    named,
  ) => {
    const { api, recorder } = apiWith({ json: CHANNEL_JSON })

    await expect(api.channels.create(request)).rejects.toThrow(named)
    expect(recorder.requests).toHaveLength(0)
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
