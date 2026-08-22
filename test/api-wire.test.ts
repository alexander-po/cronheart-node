import { describe, expect, it } from 'vitest'
import { CREATE_RETRY_BASE_DELAY_MS } from '../src/api/constants.js'
import {
  ApiChannelDeliveryError,
  ApiHydrationError,
  ApiInvalidRequestError,
  ApiRateLimitError,
  ApiTransportError,
  ApiUnexpectedResponseError,
} from '../src/api/errors.js'
import {
  ACCOUNT_JSON,
  API_KEY,
  BASE_URL,
  CHANNEL_ID,
  CHANNEL_JSON,
  MONITOR_JSON,
  MONITOR_UUID,
  type RecordedRequest,
  apiWith,
  createApiRecorder,
} from './support/api-recorder.js'
import { ofKind } from './support/errors.js'

function bodyOf(request: RecordedRequest | undefined): Record<string, unknown> {
  return JSON.parse(String(request?.body)) as Record<string, unknown>
}

function pathOf(request: RecordedRequest | undefined): string {
  return new URL(String(request?.url)).pathname
}

const CREATE = {
  name: 'nightly-backup',
  scheduleKind: 'cron',
  scheduleExpr: '0 3 * * *',
} as const

describe('the requests it composes', () => {
  it('addresses each route under the versioned base path', async () => {
    const { api, recorder } = apiWith((request) =>
      request.method === 'DELETE' ? { status: 204 } : { json: MONITOR_JSON },
    )

    await api.monitors.get(MONITOR_UUID)
    await api.monitors.pause(MONITOR_UUID)
    await api.monitors.rotateUuid(MONITOR_UUID)
    await api.monitors.delete(MONITOR_UUID)

    expect(recorder.requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      `GET /api/v1/monitors/${MONITOR_UUID}`,
      `POST /api/v1/monitors/${MONITOR_UUID}/pause`,
      `POST /api/v1/monitors/${MONITOR_UUID}/rotate-uuid`,
      `DELETE /api/v1/monitors/${MONITOR_UUID}`,
    ])
  })

  it('fills in the confirmation a rotation asks for, since the caller already named it', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.rotateUuid(MONITOR_UUID)

    expect(bodyOf(recorder.requests[0])).toEqual({ confirm: MONITOR_UUID })
  })

  it('writes the wire field names, not the ones this package reads them back as', async () => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await api.monitors.create({ ...CREATE, tz: 'Europe/Warsaw', graceSeconds: 120 })

    expect(Object.keys(bodyOf(recorder.requests[0])).sort()).toEqual([
      'grace_seconds',
      'name',
      'schedule_expr',
      'schedule_kind',
      'tz',
    ])
  })

  it('sends no key for routing the caller left out, and an empty one when they asked for it', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.update(MONITOR_UUID, { name: 'renamed' })
    await api.monitors.update(MONITOR_UUID, { channelIds: [] })

    expect(bodyOf(recorder.requests[0])).toEqual({ name: 'renamed' })
    expect(bodyOf(recorder.requests[1])).toEqual({ channel_ids: [] })
  })

  it('carries a channel identifier as the digits the listing reported, not as a number', async () => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await api.monitors.create({ ...CREATE, channelIds: [CHANNEL_ID, 7] })

    expect(String(recorder.requests[0]?.body)).toContain(`"${CHANNEL_ID}"`)
    expect(bodyOf(recorder.requests[0])['channel_ids']).toEqual([CHANNEL_ID, '7'])
    expect(String(Number(CHANNEL_ID))).not.toBe(CHANNEL_ID)
  })

  it('refuses an identifier that would reach the service as channel zero', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    for (const bad of ['ops-inbox', '', '12a', -1, 1.5]) {
      await expect(
        api.monitors.create({ ...CREATE, channelIds: [bad as string] }),
      ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    }

    expect(recorder.requests).toEqual([])
  })
})

describe('the vocabularies', () => {
  it('reads a member it has never seen and hands it back unchanged', async () => {
    const { api } = apiWith({
      json: {
        ...MONITOR_JSON,
        status: 'quarantined',
        schedule_kind: 'solar',
        channels: [{ id: '1', kind: 'matrix', label: 'ops room' }],
      },
    })

    const read = await api.monitors.get(MONITOR_UUID)

    expect(read.status).toBe('quarantined')
    expect(read.scheduleKind).toBe('solar')
    expect(read.channels[0]?.kind).toBe('matrix')
  })

  it('refuses a member it has never seen on a write, before any request exists', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await expect(
      api.monitors.create({ ...CREATE, scheduleKind: 'solar' as 'cron' }),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    await expect(api.monitors.snooze(MONITOR_UUID, '2h' as '1h')).rejects.toBeInstanceOf(
      ApiInvalidRequestError,
    )
    await expect(
      api.channels.create({ kind: 'matrix' as 'email', label: 'ops room' }),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)

    expect(recorder.requests).toEqual([])
  })

  it('refuses the six-field cron dialect by naming the dialect, before any request exists', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await expect(
      api.monitors.create({ ...CREATE, scheduleExpr: '0 0 3 * * *' }),
    ).rejects.toThrow(/sixth leading seconds field/i)
    await expect(api.monitors.create({ ...CREATE, scheduleExpr: '@reboot' })).rejects.toThrow(
      /@reboot/,
    )

    expect(recorder.requests).toEqual([])
  })

  it('accepts the aliases the service does accept, in any case', async () => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await api.monitors.create({ ...CREATE, scheduleExpr: '@DAILY' })
    await api.monitors.create({ ...CREATE, scheduleKind: 'interval', scheduleExpr: '900' })
    await api.monitors.create({ ...CREATE, scheduleKind: 'simple', scheduleExpr: 'hourly' })

    expect(recorder.requests).toHaveLength(3)
  })

  it('refuses an interval outside the seconds the service will take', async () => {
    const { api } = apiWith({ json: MONITOR_JSON })

    for (const seconds of ['29', '31622401', '٣٠', '30.0', ' 30']) {
      await expect(
        api.monitors.create({ ...CREATE, scheduleKind: 'interval', scheduleExpr: seconds }),
      ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    }
  })
})

describe('reading a response', () => {
  it('keeps the service timestamps as the strings they arrived as', async () => {
    const { api } = apiWith({ json: MONITOR_JSON })

    const read = await api.monitors.get(MONITOR_UUID)

    expect(read.createdAt).toBe(MONITOR_JSON.created_at)
    expect(read.nextExpectedAt).toBe(MONITOR_JSON.next_expected_at)
    expect(read.snoozedUntil).toBeNull()
  })

  it('reports a body it cannot read as a failure of its own, not as an empty result', async () => {
    const { api } = apiWith({ json: { ...MONITOR_JSON, grace_seconds: 'sixty' } })

    await expect(api.monitors.get(MONITOR_UUID)).rejects.toBeInstanceOf(ApiHydrationError)
  })

  it('reports a body that is not JSON at all as a transport failure', async () => {
    const { api } = apiWith({ status: 200, body: '<html>hello</html>' })

    await expect(api.account.get()).rejects.toBeInstanceOf(ApiTransportError)
  })

  it('takes a delete as done when the service answers with no content', async () => {
    const { api } = apiWith({ status: 204 })

    await expect(api.monitors.delete(MONITOR_UUID)).resolves.toBeUndefined()
  })

  it('reads the account budget the plan gate is judged against', async () => {
    const { api } = apiWith({ json: ACCOUNT_JSON })

    const account = await api.account.get()

    expect(account.plan.key).toBe('starter')
    expect(account.monitorBudget.remaining).toBe(17)
    expect(account.apiRateLimit.limit).toBe(120)
  })

  it('hands back a rotated webhook secret and the channel it belongs to', async () => {
    const { api } = apiWith({ json: { ...CHANNEL_JSON, kind: 'webhook', secret: 'rotated-secret' } })

    const rotated = await api.channels.rotateSecret(CHANNEL_ID)

    expect(rotated.secret).toBe('rotated-secret')
    expect(rotated.channel.id).toBe(CHANNEL_ID)
  })

  it('says a channel test failed downstream rather than blaming the API', async () => {
    const { api } = apiWith({ status: 502, json: { status: 502 } })

    await expect(api.channels.test(CHANNEL_ID)).rejects.toBeInstanceOf(ApiChannelDeliveryError)
  })

  it('reads a 502 anywhere else as an unexpected answer, not as a delivery failure', async () => {
    const { api } = apiWith({ status: 502, json: { status: 502 } })
    const failure = await api.monitors.get(MONITOR_UUID).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiUnexpectedResponseError)
    expect(failure).not.toBeInstanceOf(ApiChannelDeliveryError)
  })
})

describe('rate-limit reporting', () => {
  const headers = {
    'x-ratelimit-limit': '120',
    'x-ratelimit-remaining': '7',
    'x-ratelimit-reset': '1787227200',
  }

  it('reports the reset as the timestamp it is, not as a delay', async () => {
    const { api } = apiWith({ json: ACCOUNT_JSON, headers })

    await api.account.get()

    expect(api.rateLimit()).toEqual({ limit: 120, remaining: 7, resetAt: 1787227200 })
    expect(api.rateLimit()?.resetAt).toBeGreaterThan(Date.now() / 1000 - 86400 * 365 * 50)
  })

  it('keeps the last reading through the two statuses that carry no headers at all', async () => {
    let answered = 0
    const { api } = apiWith(() =>
      (answered += 1) === 1
        ? { json: ACCOUNT_JSON, headers }
        : { status: 402, json: { status: 402 } },
    )

    await api.account.get()
    await api.account.get().catch(() => undefined)

    expect(api.rateLimit()).toEqual({ limit: 120, remaining: 7, resetAt: 1787227200 })
  })

  it('reports the retry guidance a limited response carried, from the header or the body', async () => {
    const { api } = apiWith({
      status: 429,
      json: { status: 429, retry_after: 30 },
      headers: { 'retry-after': '45' },
    })

    const failure = await api.account.get().catch((error: unknown) => error)

    ofKind(failure, 'rate-limit')
    expect(failure).toBeInstanceOf(ApiRateLimitError)
    expect(failure.retryAfterSeconds).toBe(45)
  })
})

describe('when a request may be sent again', () => {
  it('never sends a create twice without a key that makes the second one safe', async () => {
    const { api, recorder } = apiWith(
      { rejectWith: new Error('socket hang up') },
      { retries: 3 },
    )

    await expect(api.monitors.create(CREATE)).rejects.toBeInstanceOf(ApiTransportError)

    expect(recorder.requests).toHaveLength(1)
  })

  it('sends a create again when a key was given, byte for byte and after a wait', async () => {
    let answered = 0
    const { api, recorder } = apiWith(
      () => ((answered += 1) === 1 ? { rejectWith: new Error('socket hang up') } : { status: 201, json: MONITOR_JSON }),
      { retries: 2 },
    )
    const startedAt = Date.now()

    await api.monitors.create(CREATE, { idempotencyKey: 'a-key-the-caller-chose' })

    expect(recorder.requests).toHaveLength(2)
    expect(recorder.requests[1]?.body).toBe(recorder.requests[0]?.body)
    expect(recorder.requests[1]?.headers['Idempotency-Key']).toBe('a-key-the-caller-chose')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CREATE_RETRY_BASE_DELAY_MS - 5)
  })

  it('says a conflicted create may have been created, rather than reading it as a refusal', async () => {
    const { api } = apiWith({ status: 409, json: { status: 409, detail: 'Already in progress.' } })

    await expect(
      api.monitors.create(CREATE, { idempotencyKey: 'a-key-the-caller-chose' }),
    ).rejects.toThrow(/read the resource back/i)
  })

  it('reads a listing again when the service was briefly unreachable', async () => {
    let answered = 0
    const { api, recorder } = apiWith(
      () =>
        (answered += 1) === 1
          ? { rejectWith: new Error('socket hang up') }
          : { json: { data: [], total: 0, limit: 50, offset: 0 } },
      { retries: 2 },
    )

    await api.monitors.list()

    expect(recorder.requests).toHaveLength(2)
  })

  it('never sends a rate-limited or rejected request again', async () => {
    for (const status of [429, 422, 404, 401]) {
      const { api, recorder } = apiWith({ status, json: { status } }, { retries: 3 })

      await api.monitors.list().catch(() => undefined)

      expect(recorder.requests).toHaveLength(1)
    }
  })

  it('never sends a rotation or a channel test again, whatever went wrong', async () => {
    const { api, recorder } = apiWith({ rejectWith: new Error('socket hang up') }, { retries: 3 })

    await api.monitors.rotateUuid(MONITOR_UUID).catch(() => undefined)
    await api.channels.test(CHANNEL_ID).catch(() => undefined)

    expect(recorder.requests).toHaveLength(2)
  })

  it('identifies itself and asks for JSON on every request it makes', async () => {
    const { api, recorder } = apiWith({ json: ACCOUNT_JSON })

    await api.account.get()

    expect(recorder.requests[0]?.headers['User-Agent']).toMatch(/^cronheart-node\/\S+ contract\//)
    expect(recorder.requests[0]?.headers['Accept']).toBe('application/json')
    expect(recorder.requests[0]?.headers['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(recorder.requests[0]?.url.startsWith(`${BASE_URL}/api/v1/`)).toBe(true)
  })

  it('leaves no response body open behind any of that', async () => {
    const { api, recorder } = apiWith({ json: ACCOUNT_JSON })

    await api.account.get()
    await api.monitors.list().catch(() => undefined)

    expect(recorder.requests).toHaveLength(2)
    expect(recorder.undrainedBodies).toBe(0)
  })

  it('counts a body nobody asked for, so the reading above is a result and not a constant', async () => {
    const recorder = createApiRecorder({ json: ACCOUNT_JSON })

    await recorder.fetch(`${BASE_URL}/api/v1/account`, {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    })

    expect(recorder.undrainedBodies).toBe(1)
  })

  it('cancels a body whose read rejects, which is the only way one is ever left open', async () => {
    const { api, recorder } = apiWith({
      json: ACCOUNT_JSON,
      readRejectsWith: new Error('the body cannot be read'),
    })

    // The stub carries a body that hydrates, so a hydration failure is the read having
    // rejected rather than the option being quietly ignored.
    await expect(api.account.get()).rejects.toThrow(ApiHydrationError)
    expect(recorder.undrainedBodies).toBe(0)
  })
})

describe('the recorded management response', () => {
  it('is read through the stream rather than whole, which is what a real response gives', async () => {
    const recorder = createApiRecorder({ json: { data: [], total: 0, limit: 50, offset: 0 } })
    let readWhole = false
    const { api } = apiWith(
      {},
      {
        fetch: (url, init) =>
          recorder.fetch(url, init).then((response) => {
            const whole = response.text?.bind(response)

            return Object.assign(response, {
              text: () => {
                readWhole = true

                return whole?.() ?? Promise.resolve('')
              },
            })
          }),
      },
    )

    const page = await api.monitors.list()

    expect(page.total).toBe(0)
    expect(readWhole).toBe(false)
  })
})
