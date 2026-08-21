import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RETRIES,
  PING_BODY_CAP_BYTES,
  PING_BODY_TRUNCATION_MARKER,
  RUNTIME_HEADER_MAX_VALUE,
  RUNTIME_HEADER_NAME,
} from '../src/constants.js'
import { createPingClient } from '../src/ping/client.js'
import { PING_DUPLICATE_BODY } from '../src/ping/outcome.js'
import type { FetchLike, PingClientOptions, PingHttpResponse } from '../src/ping/types.js'
import { createPingRecorder } from '../src/testing.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000a1'
const BASE = 'https://ping.example'

let recorder = createPingRecorder()

function client(extra: PingClientOptions = {}) {
  return createPingClient({
    baseUrl: BASE,
    fetch: recorder.fetch,
    env: {},
    monitors: { job: MONITOR_ID },
    ...extra,
  })
}

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).length
}

beforeEach(() => {
  recorder = createPingRecorder()
})

describe('the ping request', () => {
  it('addresses the monitor with no action segment for a bare check-in', async () => {
    const result = await client().ping('job')

    expect(recorder.pings).toHaveLength(1)
    expect(recorder.pings[0]?.url).toBe(`${BASE}/ping/${MONITOR_ID}`)
    expect(recorder.pings[0]?.action).toBeNull()
    expect(result.action).toBe('heartbeat')
  })

  it('appends exactly the literal segment each named call stands for', async () => {
    const sdk = client()
    await sdk.start('job')
    await sdk.success('job')
    await sdk.fail('job')

    expect(recorder.pings.map((ping) => ping.action)).toEqual(['start', 'success', 'fail'])
  })

  // A GET answered from a cache reports a check-in the service never saw, so the verb does
  // not depend on the body. The contract states the emitted method under ping.request.
  it('posts whether or not it carries a body, so no intermediary may answer for the server', async () => {
    const sdk = client()
    await sdk.ping('job')
    await sdk.fail('job', { body: 'stderr tail' })

    expect(recorder.pings.map((ping) => ping.method)).toEqual(['POST', 'POST'])
    expect(recorder.pings[0]?.body).toBeUndefined()
    expect(recorder.pings[1]?.body).toBe('stderr tail')
  })

  it('identifies itself and sends no authorization, because the ping route is anonymous', async () => {
    await client().ping('job')

    expect(recorder.pings).toHaveLength(1)
    const headers = recorder.pings[0]?.headers ?? {}

    expect(headers['User-Agent']).toMatch(/^cronheart-node\/\S+ contract\/\S+/)
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization')
  })
})

describe('response classification', () => {
  it.each([
    [200, 'OK', 'accepted', true],
    [200, PING_DUPLICATE_BODY, 'duplicate', true],
    [200, 'something else entirely', 'accepted', true],
    [404, 'Monitor not found', 'not-found', false],
    [410, 'Monitor paused', 'paused', false],
    [429, 'Rate limited', 'rate-limited', false],
    [400, 'Bad request', 'unexpected', false],
  ])('maps %i %s to %s', async (status, body, outcome, ok) => {
    recorder.respondWith({ status, body })

    const result = await client({ retries: 0 }).ping('job')

    expect(result.outcome).toBe(outcome)
    expect(result.ok).toBe(ok)
    expect(result.status).toBe(status)
    expect(result.sent).toBe(true)
  })

  it('reports Retry-After without acting on it, because a rate-limited ping is not retried', async () => {
    recorder.respondWith({ status: 429, body: 'Rate limited', headers: { 'retry-after': '17' } })

    const result = await client({ retries: 3 }).ping('job')

    expect(result.retryAfterSeconds).toBe(17)
    expect(recorder.pings).toHaveLength(1)
  })
})

describe('retries', () => {
  it('retries a server error up to the budget and no further', async () => {
    recorder.respondWith({ status: 503, body: 'nope' })

    const result = await client({ retries: 2 }).ping('job')

    expect(recorder.pings).toHaveLength(3)
    expect(result.attempts).toBe(3)
    expect(result.outcome).toBe('server-error')
  })

  it('never retries a client error', async () => {
    recorder.respondWith({ status: 404, body: 'Monitor not found' })

    const result = await client({ retries: 3 }).ping('job')

    expect(recorder.pings).toHaveLength(1)
    expect(result.attempts).toBe(1)
  })

  it('stops retrying as soon as an attempt is accepted', async () => {
    recorder.respondWith((_request, attempt) =>
      attempt === 1 ? { status: 500, body: 'nope' } : { status: 200, body: 'OK' },
    )

    const result = await client({ retries: 3 }).ping('job')

    expect(recorder.pings).toHaveLength(2)
    expect(result.outcome).toBe('accepted')
  })

  it('spends the timeout as one budget across attempts rather than per attempt', async () => {
    recorder.respondWith({ hang: true })
    const started = Date.now()

    const result = await client({ retries: 4, timeoutMs: 60 }).ping('job')

    expect(result.outcome).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(60 * 3)
  })

  it('reports the server error it already had when the budget runs out, not a bare timeout', async () => {
    recorder.respondWith({ status: 503, body: 'nope' })

    const result = await client({ retries: MAX_RETRIES, timeoutMs: 120 }).ping('job')

    expect(result.outcome).toBe('server-error')
    expect(result.status).toBe(503)
    expect(result.sent).toBe(true)
    expect(recorder.pings.length).toBeLessThan(MAX_RETRIES + 1)
    expect(result.attempts).toBe(recorder.pings.length)
  })

  it('surfaces a transport rejection as a network error rather than a throw', async () => {
    recorder.respondWith({ rejectWith: new Error('socket hang up') })

    const result = await client({ retries: 1 }).ping('job')

    expect(result.outcome).toBe('network-error')
    expect(recorder.pings).toHaveLength(2)
  })
})

describe('response bodies', () => {
  it('drains or cancels every body, so no socket stays pooled after the job ends', async () => {
    recorder.respondWith((_request, attempt) =>
      attempt === 1 ? { status: 500, body: 'nope' } : { status: 200, body: 'OK' },
    )
    const sdk = client({ retries: 2 })

    await sdk.ping('job')
    await sdk.success('job')

    expect(recorder.undrainedBodies).toBe(0)
  })

  it('counts a body nobody asked for, so the reading above is a result and not a constant', async () => {
    recorder.respondWith({ status: 200, body: 'OK' })

    await recorder.fetch(`${BASE}/ping/${MONITOR_ID}`, {
      method: 'POST',
      headers: {},
      signal: new AbortController().signal,
    })

    expect(recorder.undrainedBodies).toBe(1)
  })

  it('cancels a body whose read rejects, which is the only way one is ever left open', async () => {
    recorder.respondWith({
      body: PING_DUPLICATE_BODY,
      readRejectsWith: new Error('the body cannot be read'),
    })

    const result = await client().ping('job')

    // The stub carries the duplicate body, so an outcome of accepted is the read having
    // rejected rather than the option being quietly ignored.
    expect(result.outcome).toBe('accepted')
    expect(recorder.undrainedBodies).toBe(0)
  })
})

describe('the runtime header', () => {
  it('rides on a terminal ping only, rounded to whole milliseconds', async () => {
    const sdk = client()
    await sdk.success('job', { runtimeMs: 1500.6 })
    await sdk.fail('job', { runtimeMs: 12.2 })
    await sdk.start('job', { runtimeMs: 999 })
    await sdk.ping('job', { runtimeMs: 999 })

    expect(recorder.pings.map((ping) => ping.headers[RUNTIME_HEADER_NAME])).toEqual([
      '1501',
      '12',
      undefined,
      undefined,
    ])
  })

  it('sends the maximum itself, so the omission below is a bound and not an off-by-one', async () => {
    await client().success('job', { runtimeMs: RUNTIME_HEADER_MAX_VALUE })

    expect(recorder.pings).toHaveLength(1)
    expect(recorder.pings[0]?.headers[RUNTIME_HEADER_NAME]).toBe(String(RUNTIME_HEADER_MAX_VALUE))
  })

  it('omits a runtime past the maximum rather than clamping it into a duration that never happened', async () => {
    await client().success('job', { runtimeMs: RUNTIME_HEADER_MAX_VALUE + 5000 })

    expect(recorder.pings).toHaveLength(1)
    expect(recorder.pings[0]?.headers[RUNTIME_HEADER_NAME]).toBeUndefined()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'omits the header rather than sending %s',
    async (runtimeMs) => {
      await client().success('job', { runtimeMs })

      expect(recorder.pings).toHaveLength(1)
      expect(recorder.pings[0]?.headers[RUNTIME_HEADER_NAME]).toBeUndefined()
    },
  )
})

describe('the body', () => {
  it('truncates by encoded bytes and marks the cut', async () => {
    await client().fail('job', { body: 'x'.repeat(PING_BODY_CAP_BYTES * 2) })
    const body = recorder.pings[0]?.body ?? ''

    expect(bytesOf(body)).toBe(PING_BODY_CAP_BYTES)
    expect(body.endsWith(PING_BODY_TRUNCATION_MARKER)).toBe(true)
  })

  it('keeps the tail when asked, because the last lines are the diagnostic', async () => {
    await client({ truncate: 'tail' }).fail('job', {
      body: `${'x'.repeat(PING_BODY_CAP_BYTES * 2)}LAST LINE`,
    })
    const body = recorder.pings[0]?.body ?? ''

    expect(body.startsWith(PING_BODY_TRUNCATION_MARKER)).toBe(true)
    expect(body.endsWith('LAST LINE')).toBe(true)
  })

  it('redacts before truncating, so a cut cannot split a secret out of its pattern', async () => {
    const secret = 'SECRET-123456-END'
    await client({ redact: [/SECRET-[0-9]{6}-END/g] }).fail('job', {
      body: `${'a'.repeat(9975)}${secret}${'b'.repeat(100)}`,
    })
    const body = recorder.pings[0]?.body ?? ''

    expect(body).not.toContain('SECRET-')
    expect(body).not.toContain('123456')
  })
})

describe('a caller redaction pattern', () => {
  it.each([/tok-[0-9]/gy, /tok-[0-9]/y])(
    'redacts every occurrence even when it arrives sticky (%s)',
    async (pattern) => {
      await client({ redact: [pattern] }).fail('job', { body: 'prefix tok-1 and tok-2' })

      expect(recorder.pings[0]?.body).toBe('prefix [redacted] and [redacted]')
    },
  )

  it('keeps matching a plain string pattern everywhere it appears', async () => {
    await client({ redact: ['tok-1'] }).fail('job', { body: 'tok-1 and tok-1' })

    expect(recorder.pings[0]?.body).toBe('[redacted] and [redacted]')
  })
})

describe('a caller-initiated abort', () => {
  const abortable: FetchLike = (_url, init) =>
    new Promise<PingHttpResponse>((_resolve, reject) => {
      const signal = init.signal as AbortSignal

      if (signal.aborted) {
        reject(new Error('aborted before the request left'))

        return
      }

      signal.addEventListener('abort', () => reject(new Error('aborted in flight')), { once: true })
    })

  it('is reported as an abort rather than as a deadline nobody configured', async () => {
    const controller = new AbortController()
    const sdk = client({ fetch: abortable, signal: controller.signal, timeoutMs: 5000 })
    const settled = sdk.ping('job')
    setTimeout(() => controller.abort(), 10)

    const result = await settled

    expect(result.outcome).toBe('aborted')
    expect(result.ok).toBe(false)
  })

  it('is reported the same way when the signal was already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await client({
      fetch: abortable,
      signal: controller.signal,
      timeoutMs: 5000,
    }).ping('job')

    expect(result.outcome).toBe('aborted')
  })
})

describe('the caller signal', () => {
  it('leaves no listener behind, so a long-lived signal cannot accumulate them', async () => {
    const controller = new AbortController()
    const signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    let live = 0
    let peak = 0
    Object.assign(signal, {
      addEventListener: (...args: Parameters<typeof add>) => {
        live += 1
        peak = Math.max(peak, live)
        add(...args)
      },
      removeEventListener: (...args: Parameters<typeof remove>) => {
        live -= 1
        remove(...args)
      },
    })
    const sdk = client({ signal })

    for (let index = 0; index < 25; index += 1) {
      await sdk.ping('job')
    }

    expect(peak).toBeGreaterThan(0)
    expect(live).toBe(0)
  })

  it('ignores something that is not a signal rather than letting it throw', async () => {
    const result = await client({
      signal: 'definitely not a signal' as unknown as undefined,
    }).ping('job')

    expect(result.outcome).toBe('accepted')
  })
})

describe('a runtime without fetch', () => {
  it('reports the absence as a result instead of throwing at the call site', async () => {
    const original = Reflect.get(globalThis, 'fetch') as unknown
    Reflect.deleteProperty(globalThis, 'fetch')

    try {
      const result = await createPingClient({
        baseUrl: BASE,
        env: {},
        monitors: { job: MONITOR_ID },
      }).ping('job')

      expect(result.outcome).toBe('unexpected')
      expect(result.error?.message).toContain('no fetch')
    } finally {
      Reflect.set(globalThis, 'fetch', original)
    }
  })
})
