import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRIES, RETRY_AFTER_CAP_MS, RETRY_FLOOR_DELAY_MS } from '../src/constants.js'
import { createPingClient } from '../src/ping/client.js'
import { createPingRecorder } from '../src/testing.js'
import { attemptsFor } from '../src/transport/attempts.js'
import { type TransportRequest, send } from '../src/transport/send.js'

const MONITOR_ID = '00000000-0000-0000-0000-000000000000'

function waits(): { readonly given: number[]; readonly wait: NonNullable<TransportRequest['wait']> } {
  const given: number[] = []

  return {
    given,
    wait: (ms) => {
      given.push(ms)

      return Promise.resolve()
    },
  }
}

function sent(
  recorder: ReturnType<typeof createPingRecorder>,
  wait: TransportRequest['wait'],
  extra: Partial<TransportRequest> = {},
) {
  return send({
    url: `https://ping.example/ping/${MONITOR_ID}`,
    method: 'POST',
    headers: {},
    body: undefined,
    timeoutMs: 60_000,
    bodyCapBytes: 1024,
    attempts: attemptsFor(DEFAULT_RETRIES),
    signal: undefined,
    fetch: recorder.fetch,
    wait,
    ...extra,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the wait before a retried ping', () => {
  it('honours Retry-After on a 503', async () => {
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 503, headers: { 'retry-after': '1' } } : { status: 200 },
    )
    const { given, wait } = waits()

    const result = await sent(recorder, wait)

    expect(result.status).toBe(200)
    expect(result.attempts).toBe(2)
    expect(given).toEqual([1000])
  })

  it('caps one wait at the ceiling however long the service asks', async () => {
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 503, headers: { 'retry-after': '120' } } : { status: 200 },
    )
    const { given, wait } = waits()

    await sent(recorder, wait)

    expect(given).toEqual([RETRY_AFTER_CAP_MS])
  })

  it.each([
    ['is absent', {}],
    ['is zero', { 'retry-after': '0' }],
    ['is not a duration', { 'retry-after': 'soon' }],
  ])('keeps the floor when Retry-After %s', async (_what, headers) => {
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 503, headers } : { status: 200 },
    )
    const { given, wait } = waits()

    await sent(recorder, wait)

    expect(given).toEqual([RETRY_FLOOR_DELAY_MS])
  })

  it('reads Retry-After on a 503 only', async () => {
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 500, headers: { 'retry-after': '3' } } : { status: 200 },
    )
    const { given, wait } = waits()

    await sent(recorder, wait)

    expect(given).toEqual([RETRY_FLOOR_DELAY_MS])
  })

  it('retries a 503 again with the wait each answer states', async () => {
    const recorder = createPingRecorder((_, attempt) => ({
      status: attempt < 3 ? 503 : 200,
      headers: { 'retry-after': attempt === 1 ? '2' : '1' },
    }))
    const { given, wait } = waits()

    const result = await sent(recorder, wait)

    expect(result.attempts).toBe(3)
    expect(given).toEqual([2000, 1000])
  })

  it('makes three attempts at most by default and reports the last 503', async () => {
    const recorder = createPingRecorder({ status: 503, headers: { 'retry-after': '1' } })
    const { given, wait } = waits()

    const result = await sent(recorder, wait, { attempts: attemptsFor(DEFAULT_RETRIES) })

    expect(recorder.pings).toHaveLength(3)
    expect(result.status).toBe(503)
    expect(given).toEqual([1000, 1000])
  })

  it('retries a connection error after the floor, whatever an earlier 503 said', async () => {
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1
        ? { status: 503, headers: { 'retry-after': '3' } }
        : attempt === 2
          ? { rejectWith: new Error('reset') }
          : { status: 200 },
    )
    const { given, wait } = waits()

    const result = await sent(recorder, wait)

    expect(result.attempts).toBe(3)
    expect(given).toEqual([3000, RETRY_FLOOR_DELAY_MS])
  })

  it.each([400, 404, 410, 429])('never retries a %i', async (status) => {
    const recorder = createPingRecorder({ status, headers: { 'retry-after': '1' } })
    const { given, wait } = waits()

    const result = await sent(recorder, wait)

    expect(recorder.pings).toHaveLength(1)
    expect(result.status).toBe(status)
    expect(given).toEqual([])
  })

  it('returns the held 503 at once when the wait it asks for does not fit the budget', async () => {
    const recorder = createPingRecorder({ status: 503, headers: { 'retry-after': '5' } })
    const { given, wait } = waits()

    const result = await sent(recorder, wait, { timeoutMs: 2000 })

    expect(given).toEqual([])
    expect(recorder.pings).toHaveLength(1)
    expect(result.status).toBe(503)
    expect(result.attempts).toBe(1)
  })

  it('makes no further request once the caller has aborted during the wait', async () => {
    const recorder = createPingRecorder({ status: 503, headers: { 'retry-after': '1' } })
    const controller = new AbortController()

    const failure = await sent(
      recorder,
      () => {
        controller.abort()

        return Promise.resolve()
      },
      { signal: controller.signal },
    ).catch((error: unknown) => error as { reason?: string; attempts?: number })

    expect(recorder.pings).toHaveLength(1)
    expect(failure).toMatchObject({ reason: 'aborted', attempts: 1 })
  })
})

describe('a retry that runs out of budget', () => {
  it('keeps the 503 already in hand rather than reporting a timeout', async () => {
    vi.useFakeTimers()
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 503, headers: { 'retry-after': '4' } } : { hang: true },
    )

    const pending = sent(recorder, undefined, { timeoutMs: 5000 })
    await vi.advanceTimersByTimeAsync(6000)
    const result = await pending

    expect(result.status).toBe(503)
    expect(recorder.pings).toHaveLength(2)
  })
})

describe('the wait through the client', () => {
  it('spends the stated second on a timer and then lands the check-in', async () => {
    vi.useFakeTimers()
    const recorder = createPingRecorder((_, attempt) =>
      attempt === 1 ? { status: 503, headers: { 'retry-after': '1' } } : { status: 200 },
    )
    const sdk = createPingClient({
      baseUrl: 'https://ping.example',
      fetch: recorder.fetch,
      env: {},
      monitors: { job: MONITOR_ID },
    })

    const pending = sdk.ping('job')
    await vi.advanceTimersByTimeAsync(RETRY_FLOOR_DELAY_MS + 100)

    expect(recorder.pings).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(recorder.pings).toHaveLength(2)
    expect(result.outcome).toBe('accepted')
  })

  it('wakes a wait early when the caller aborts', async () => {
    const recorder = createPingRecorder({ status: 503, headers: { 'retry-after': '5' } })
    const controller = new AbortController()
    const sdk = createPingClient({
      baseUrl: 'https://ping.example',
      fetch: recorder.fetch,
      env: {},
      monitors: { job: MONITOR_ID },
      timeoutMs: 60_000,
    })

    const started = performance.now()
    const pending = sdk.ping('job', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    const result = await pending

    expect(performance.now() - started).toBeLessThan(2000)
    expect(result.outcome).toBe('aborted')
    expect(recorder.pings).toHaveLength(1)
  })
})
