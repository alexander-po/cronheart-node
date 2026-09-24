import { type IncomingMessage, type Server, type ServerResponse, createServer, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { PassThrough, Readable } from 'node:stream'
import { inspect } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { API_RESPONSE_BODY_CAP_BYTES } from '../src/api/constants.js'
import {
  DEFAULT_RETRIES,
  MAX_RETRIES,
  PING_BODY_CAP_BYTES,
  PING_BODY_TRUNCATION_MARKER,
  PING_RESPONSE_BODY_CAP_BYTES,
  RETRY_FLOOR_DELAY_MS,
  RUNTIME_HEADER_MAX_VALUE,
  RUNTIME_HEADER_NAME,
} from '../src/constants.js'
import { createPingClient } from '../src/ping/client.js'
import { PING_DUPLICATE_BODY } from '../src/ping/outcome.js'
import type {
  FetchLike,
  PingClientOptions,
  PingHttpResponse,
  PingResponseBody,
  PingResponseBodyReader,
  PingResult,
} from '../src/ping/types.js'
import { type StubResponse, createPingRecorder } from '../src/testing.js'
import { detachedCountdown } from '../src/timer.js'
import { attemptsFor } from '../src/transport/attempts.js'
import { TransportFailure, type TransportRequest, send } from '../src/transport/send.js'

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

// Taken before any test fakes the clock, so it is the one timer that still fires under fake
// timers: a check-in waiting on a faked one then reads as stuck rather than as a hung suite.
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

async function outcomeOnFakeTimers(
  ping: () => Promise<{ readonly outcome: string }>,
  advanceMs = 0,
): Promise<string> {
  let guard: ReturnType<typeof setTimeout> | undefined
  const stuck = new Promise<string>((resolve) => {
    guard = realSetTimeout(() => resolve('stuck on a faked timer'), 2000)
  })

  vi.useFakeTimers()

  try {
    const settled = ping().then((result) => result.outcome)

    if (advanceMs > 0) {
      await vi.advanceTimersByTimeAsync(advanceMs)
    }

    return await Promise.race([settled, stuck])
  } finally {
    vi.useRealTimers()
    realClearTimeout(guard)
  }
}

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

// The one shape where an answer is in hand and none of its body is. Modelled the way a real
// response behaves: a read disturbs the body, and aborting the request is what tears it down.
function stallsAfterAnswering(status: number): {
  readonly fetch: FetchLike
  released(): boolean
} {
  let released = false
  let reading = false

  return {
    fetch: (_url, init) =>
      Promise.resolve<PingHttpResponse>({
        status,
        headers: { get: () => null },
        get bodyUsed() {
          return reading
        },
        body: {
          cancel: () => {
            released = true

            return Promise.resolve()
          },
        },
        text: () => {
          reading = true

          return new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                released = true
                reject(new Error('the body was torn down with the request'))
              },
              { once: true },
            )
          })
        },
      }),
    released: () => released,
  }
}

describe('an answer already in hand when the budget runs out', () => {
  // retries: 0, so there is no second attempt for the answer to be carried into. The only
  // thing that can report the status here is the attempt the deadline landed inside.
  it('reports the server error the attempt was holding rather than the deadline', async () => {
    const stalled = stallsAfterAnswering(503)

    const result = await client({ fetch: stalled.fetch, retries: 0, timeoutMs: 60 }).ping('job')

    expect(result.outcome).toBe('server-error')
    expect(result.status).toBe(503)
    expect(result.answered).toBe(true)
    expect(result.attempts).toBe(1)
  })

  // Nothing here cancels it: a response is disturbed from its first read, and cancelling one
  // a read holds throws rather than releasing it. Giving up on the request is the release.
  it('releases the body it gave up on, because giving up aborts the request', async () => {
    const stalled = stallsAfterAnswering(503)

    await client({ fetch: stalled.fetch, retries: 0, timeoutMs: 60 }).ping('job')

    expect(stalled.released()).toBe(true)
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

  // The recorder is what consumers test their own integration against, so a check-in
  // through it has to take the path a check-in through a real fetch takes.
  it('is read through the stream rather than whole, which is what a real response gives', async () => {
    recorder.respondWith({ body: PING_DUPLICATE_BODY })
    let readWhole = false
    const watching: FetchLike = (url, init) =>
      recorder.fetch(url, init).then((response) => {
        const whole = response.text?.bind(response)

        return Object.assign(response, {
          text: () => {
            readWhole = true

            return whole?.() ?? Promise.resolve('')
          },
        })
      })

    const result = await client({ fetch: watching }).ping('job')

    expect(result.outcome).toBe('duplicate')
    expect(readWhole).toBe(false)
  })

  it('reports an empty body as done rather than handing over a chunk of nothing', async () => {
    recorder.respondWith({ body: '' })

    const response = await recorder.fetch(`${BASE}/ping/${MONITOR_ID}`, {
      method: 'POST',
      headers: {},
      signal: new AbortController().signal,
    })
    const first = await response.body?.getReader?.().read()

    expect(first?.done).toBe(true)
  })

  it('answers a suite on fake timers, for every reply it is not asked to retry', async () => {
    const replies: readonly (readonly [StubResponse, number])[] = [
      [{ body: 'OK' }, DEFAULT_RETRIES],
      [{ body: PING_DUPLICATE_BODY }, DEFAULT_RETRIES],
      [{ body: 'x'.repeat(PING_RESPONSE_BODY_CAP_BYTES * 2) }, DEFAULT_RETRIES],
      [{ status: 404, body: 'Monitor not found' }, DEFAULT_RETRIES],
      [{ status: 503, body: 'nope' }, 0],
      [{ rejectWith: new TypeError('fetch failed') }, 0],
    ]
    const outcomes: string[] = []

    for (const [reply, retries] of replies) {
      recorder.respondWith(reply)
      outcomes.push(await outcomeOnFakeTimers(() => client({ retries }).ping('job')))
    }

    expect(outcomes).toEqual([
      'accepted',
      'duplicate',
      'accepted',
      'not-found',
      'server-error',
      'network-error',
    ])
  })

  it('answers a retried reply on fake timers once the clock is moved past its retry delays', async () => {
    recorder.respondWith({ status: 503, body: 'nope' })

    const outcome = await outcomeOnFakeTimers(
      () => client().ping('job'),
      RETRY_FLOOR_DELAY_MS * 10,
    )

    expect(outcome).toBe('server-error')
    expect(recorder.pings).toHaveLength(DEFAULT_RETRIES + 1)
  })

  it('answers a suite on fake timers through the built package, which is what gets installed', async () => {
    const { createPingRecorder: builtRecorder } = (await import(
      new URL('../dist/testing.mjs', import.meta.url).href
    )) as { createPingRecorder: typeof createPingRecorder }
    const { createPingClient: builtClient } = (await import(
      new URL('../dist/index.mjs', import.meta.url).href
    )) as { createPingClient: typeof createPingClient }
    const built = builtRecorder({ body: PING_DUPLICATE_BODY })

    const outcome = await outcomeOnFakeTimers(() =>
      builtClient({ baseUrl: BASE, fetch: built.fetch, env: {}, monitors: { job: MONITOR_ID } }).ping(
        'job',
      ),
    )

    expect(outcome).toBe('duplicate')
  })

  // Published surface a consumer can reach without the SDK in between: the refusal has to
  // arrive whichever way they read the body, and only one of the two is what the SDK takes.
  it('refuses a whole-body read the way it refuses a streamed one', async () => {
    recorder.respondWith({ readRejectsWith: new Error('the body cannot be read') })

    const response = await recorder.fetch(`${BASE}/ping/${MONITOR_ID}`, {
      method: 'POST',
      headers: {},
      signal: new AbortController().signal,
    })

    await expect(response.text?.()).rejects.toThrow('the body cannot be read')
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

const RESPONSE_CHUNK_BYTES = 1024

// The fuse is not part of the fiction of a body that never ends: it is what makes an
// unbounded read fail the assertion below rather than exhaust the worker.
const ENDLESS_BODY_FUSE_BYTES = 4 * 1024 * 1024

// Stated here rather than read from the constant the transport reads: an assertion derived
// from that constant holds however far it moves, including all the way off.
const BOUNDED_READ_CEILING_BYTES = 128 * 1024

function answersWith(
  nextChunk: () => Uint8Array | undefined | Promise<Uint8Array | undefined>,
): {
  readonly fetch: FetchLike
  cancelled(): boolean
} {
  let cancelled = false
  let pulled = 0
  const release = (): Promise<void> => {
    cancelled = true

    return Promise.resolve()
  }
  const read = (): Promise<{ done: boolean; value?: Uint8Array }> => {
    pulled += 1

    return Promise.resolve(nextChunk()).then((value) =>
      value === undefined ? { done: true } : { done: false, value },
    )
  }

  return {
    fetch: () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        // Disturbed by the first read, the way a real response is: past that point the
        // reader is the only thing that can release it.
        get bodyUsed() {
          return pulled > 0
        },
        body: { cancel: release, getReader: () => ({ read, cancel: release }) },
        // Offered the way a real response offers it: declining to call this is the fix.
        text: async () => {
          const decoder = new TextDecoder()
          let text = ''

          for (let chunk = await read(); chunk.done !== true; chunk = await read()) {
            text += decoder.decode(chunk.value, { stream: true })
          }

          return text
        },
      }),
    cancelled: () => cancelled,
  }
}

function answersEndlessly(): {
  readonly fetch: FetchLike
  cancelled(): boolean
  pulledBytes(): number
} {
  const chunk = new TextEncoder().encode('x'.repeat(RESPONSE_CHUNK_BYTES))
  let pulled = 0
  const answers = answersWith(() => {
    if (pulled >= ENDLESS_BODY_FUSE_BYTES) {
      return undefined
    }

    pulled += chunk.length

    return chunk
  })

  return { fetch: answers.fetch, cancelled: answers.cancelled, pulledBytes: () => pulled }
}

// The fuse turns a loop that makes no progress into a failed assertion rather than a pinned
// core, which is what a body of nothing but empty chunks would otherwise be.
const EMPTY_CHUNK_FUSE_READS = 200000

function answersWithNothing(): { readonly fetch: FetchLike; reads(): number } {
  const nothing = new Uint8Array(0)
  let handed = 0
  const answers = answersWith(() => {
    handed += 1

    return handed > EMPTY_CHUNK_FUSE_READS ? undefined : nothing
  })

  return { fetch: answers.fetch, reads: () => handed }
}

function answersOneByteEvery(everyMs: number): {
  readonly fetch: FetchLike
  cancelled(): boolean
  reads(): number
} {
  const byte = new TextEncoder().encode('x')
  let handed = 0
  const answers = answersWith(
    () =>
      new Promise<Uint8Array>((resolve) => {
        setTimeout(() => {
          handed += 1
          resolve(byte)
        }, everyMs)
      }),
  )

  return { fetch: answers.fetch, cancelled: answers.cancelled, reads: () => handed }
}

function ignoresTheAbort(): { readonly fetch: FetchLike; released(): boolean } {
  let released = false
  let pulled = 0
  const release = (): Promise<void> => {
    released = true

    return Promise.resolve()
  }

  return {
    fetch: () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        get bodyUsed() {
          return pulled > 0
        },
        body: {
          cancel: release,
          getReader: () => ({
            read: () => {
              pulled += 1

              return new Promise<{ done: boolean; value?: Uint8Array }>(() => {})
            },
            cancel: release,
          }),
        },
      }),
    released: () => released,
  }
}

// Stated here rather than derived from the cap: an assertion taken from the constant under
// test holds however far the accounting drifts from what that constant measures.
const WIDE_VIEW_CEILING_BYTES = 32768

function answersInWideViews(elements: number): {
  readonly fetch: FetchLike
  pulledBytes(): number
} {
  const chunk = new Float64Array(elements)
  let pulled = 0
  const answers = answersWith(() => {
    pulled += chunk.byteLength

    return pulled > WIDE_VIEW_CEILING_BYTES * 8 ? undefined : (chunk as unknown as Uint8Array)
  })

  return { fetch: answers.fetch, pulledBytes: () => pulled }
}

function answersInPiecesOf(bytes: number): { readonly fetch: FetchLike } {
  const chunk = new Uint8Array(bytes).fill(0x78)

  return answersWith(() => chunk)
}

function answersInPieces(pieces: readonly string[]): { readonly fetch: FetchLike } {
  const encoder = new TextEncoder()
  let sent = 0

  return answersWith(() => {
    const piece = pieces[sent]
    sent += 1

    return piece === undefined ? undefined : encoder.encode(piece)
  })
}

describe('a reply that arrives as a stream', () => {
  it('is classified from the pieces it arrived in, because a stream is not one string', async () => {
    const chunked = answersInPieces(['OK (dup', 'licate)'])

    const result = await client({ fetch: chunked.fetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('duplicate')
  })

  it('refuses a stream somebody else holds rather than reading it whole', async () => {
    let readWhole = false
    const held: FetchLike = () => {
      const response = new Response(PING_DUPLICATE_BODY)
      response.body?.getReader()
      const whole = response.text.bind(response)

      return Promise.resolve(
        Object.assign(response, {
          text: () => {
            readWhole = true

            return whole()
          },
        }),
      )
    }

    const result = await client({ fetch: held, retries: 0 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(readWhole).toBe(false)
  })

  it('refuses a reader it cannot read with rather than reading the body whole instead', async () => {
    let readWhole = false
    const unusable: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        bodyUsed: false,
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({}) as unknown as PingResponseBodyReader,
        },
        text: () => {
          readWhole = true

          return Promise.resolve(PING_DUPLICATE_BODY)
        },
      })

    const result = await client({ fetch: unusable, retries: 0 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(readWhole).toBe(false)
  })

  it('reads a Node stream under the cap, which is the body node-fetch hands back', async () => {
    const piece = new TextEncoder().encode('x'.repeat(RESPONSE_CHUNK_BYTES))
    let pulled = 0
    let readWhole = false
    const stream = Readable.from(
      (function* () {
        while (pulled < ENDLESS_BODY_FUSE_BYTES) {
          pulled += piece.byteLength
          yield piece
        }
      })(),
    )
    const nodeFetch: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        body: stream as unknown as PingResponseBody,
        text: async () => {
          readWhole = true
          let text = ''

          for await (const chunk of stream) {
            text += new TextDecoder().decode(chunk as Uint8Array)
          }

          return text
        },
      })

    const result = await client({ fetch: nodeFetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(readWhole).toBe(false)
    expect(pulled).toBeLessThan(BOUNDED_READ_CEILING_BYTES)
    expect(stream.destroyed).toBe(true)
  })

  it('lets go of a Node stream that stalls, rather than leaving it open', async () => {
    const stream = new Readable({ read() {} })
    stream.push(new TextEncoder().encode('O'))
    const stalls: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        body: stream as unknown as PingResponseBody,
      })

    const result = await client({ fetch: stalls, retries: 0, timeoutMs: 60 }).ping('job')

    expect(result.outcome).toBe('timeout')
    expect(stream.destroyed).toBe(true)
  })

  it('lets go of a Node stream that arrives after the check-in stopped waiting for it', async () => {
    const late = new Readable({ read() {} })
    let deliver: ((response: PingHttpResponse) => void) | undefined
    const deaf: FetchLike = () =>
      new Promise<PingHttpResponse>((resolve) => {
        deliver = resolve
      })

    const result = await client({ fetch: deaf, retries: 0, timeoutMs: 30 }).ping('job')
    deliver?.({ status: 200, headers: { get: () => null }, body: late as unknown as PingResponseBody })
    await new Promise((resolve) => setImmediate(resolve))

    expect(result.outcome).toBe('timeout')
    expect(late.destroyed).toBe(true)
  })

  it('tells a duplicate apart through a Node stream too', async () => {
    const stream = Readable.from([new TextEncoder().encode(PING_DUPLICATE_BODY)])
    const nodeFetch: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        body: stream as unknown as PingResponseBody,
        text: () => Promise.resolve(''),
      })

    const result = await client({ fetch: nodeFetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('duplicate')
  })

  it('counts the cap in bytes, which for a wider view is not the number of elements', async () => {
    const wide = answersInWideViews(128)

    const result = await client({ fetch: wide.fetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(wide.pulledBytes()).toBeLessThan(WIDE_VIEW_CEILING_BYTES)
  })

  it('reads a body that arrives a byte at a time as far as the cap, without a timer turn per byte', async () => {
    const byte = new Uint8Array([0x78])
    let pulled = 0
    const trickle = answersWith(() => {
      pulled += 1

      return byte
    })

    const result = await client({ fetch: trickle.fetch, retries: 0, timeoutMs: 2000 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(pulled).toBe(PING_RESPONSE_BODY_CAP_BYTES)
    expect(trickle.cancelled()).toBe(true)
  })

  // Stated here rather than read from the transport: the cap lands on the piece after which
  // the loop would otherwise hand the deadline a turn.
  it('ends at the cap without waiting on a timer to say so', async () => {
    const reachesTheCap = answersInPiecesOf(PING_RESPONSE_BODY_CAP_BYTES / 1024)

    const outcome = await outcomeOnFakeTimers(() =>
      client({ fetch: reachesTheCap.fetch, retries: 0 }).ping('job'),
    )

    expect(outcome).toBe('accepted')
  })

  it('is not ended by a piece that carries nothing, which is not the end of a body', async () => {
    const interrupted = answersInPieces(['OK (dup', '', 'licate)'])

    const result = await client({ fetch: interrupted.fetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('duplicate')
  })

  it('ends on a piece that is not bytes, keeping what arrived instead of losing all of it', async () => {
    const pieces: (Uint8Array | undefined)[] = [
      new TextEncoder().encode(PING_DUPLICATE_BODY),
      'not bytes at all' as unknown as Uint8Array,
    ]
    let sent = 0
    const answers = answersWith(() => {
      const piece = pieces[sent]
      sent += 1

      return piece
    })

    const result = await client({ fetch: answers.fetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('duplicate')
  })

  it('stops at the cap and cancels the rest, so an endless one cannot exhaust the host', async () => {
    const endless = answersEndlessly()

    const result = await client({ fetch: endless.fetch, retries: 0 }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(endless.pulledBytes()).toBeLessThan(BOUNDED_READ_CEILING_BYTES)
    expect(endless.pulledBytes()).toBeLessThanOrEqual(
      PING_RESPONSE_BODY_CAP_BYTES + RESPONSE_CHUNK_BYTES,
    )
    expect(endless.cancelled()).toBe(true)
  })

  it('leaves a body of nothing but empty pieces to the deadline, rather than reading it forever', async () => {
    const nothing = answersWithNothing()

    const result = await client({ fetch: nothing.fetch, retries: 0, timeoutMs: 60 }).ping('job')

    expect(result.outcome).toBe('timeout')
    expect(nothing.reads()).toBeLessThan(EMPTY_CHUNK_FUSE_READS)
  })

  it('releases the body of a transport that ignores the abort, which nothing else can', async () => {
    const deaf = ignoresTheAbort()

    const result = await client({ fetch: deaf.fetch, retries: 0, timeoutMs: 60 }).ping('job')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(result.outcome).toBe('timeout')
    expect(deaf.released()).toBe(true)
  })

  it('stops reading once the attempt is abandoned, so a trickle cannot outlive it', async () => {
    const trickle = answersOneByteEvery(5)

    const result = await client({ fetch: trickle.fetch, retries: 0, timeoutMs: 60 }).ping('job')
    const atTheDeadline = trickle.reads()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(result.outcome).toBe('timeout')
    expect(trickle.reads()).toBeLessThanOrEqual(atTheDeadline + 1)
    expect(trickle.cancelled()).toBe(true)
  })
})

interface EndlessServer {
  readonly base: string
  openSockets(): Promise<number>
  close(): Promise<void>
}

// Answers every request with a body that never ends, and counts the connections still open
// from its own side, which is where a request the client never let go of shows up.
async function endlessServer(): Promise<EndlessServer> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    const piece = new Uint8Array(64 * 1024).fill(0x78)
    let open = true
    response.on('close', () => {
      open = false
    })
    const pump = (): void => {
      while (open && response.write(piece)) {}

      if (open) {
        response.once('drain', pump)
      }
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    pump()
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    base: `http://127.0.0.1:${port}`,
    openSockets: async () => {
      for (let waited = 0; sockets.size > 0 && waited < 2000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      return sockets.size
    },
    close: () => {
      for (const socket of sockets) {
        socket.destroy()
      }

      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

// The shape node-fetch v2 hands back: the response piped through a PassThrough that carries
// an error listener of its own, and the request torn down only when the signal aborts.
const nodeFetchV2: FetchLike = (url, init) =>
  new Promise<PingHttpResponse>((resolve, reject) => {
    const outgoing = request(url, { method: init.method, headers: init.headers, agent: false })
    let body: PassThrough | undefined
    init.signal?.addEventListener(
      'abort',
      () => {
        const aborted = new Error('The user aborted a request.')
        reject(aborted)
        outgoing.destroy()
        body?.emit('error', aborted)
      },
      { once: true },
    )
    outgoing.on('error', reject)
    outgoing.on('response', (incoming) => {
      body = incoming.pipe(new PassThrough())
      body.on('error', () => undefined)
      resolve({
        status: incoming.statusCode ?? 0,
        headers: { get: (name) => String(incoming.headers[name.toLowerCase()] ?? '') || null },
        body: body as unknown as PingResponseBody,
      })
    })
    outgoing.end(init.body)
  })

describe('the connection behind a reply', () => {
  it('is let go once a capped check-in is done, so an endless answer cannot pin sockets', async () => {
    const server = await endlessServer()

    try {
      const sdk = createPingClient({
        baseUrl: server.base,
        fetch: nodeFetchV2,
        env: {},
        monitors: { job: MONITOR_ID },
        retries: 0,
        timeoutMs: 3000,
      })
      const outcomes: string[] = []

      for (let index = 0; index < 3; index += 1) {
        outcomes.push((await sdk.ping('job')).outcome)
      }

      expect(outcomes).toEqual(['accepted', 'accepted', 'accepted'])
      expect(await server.openSockets()).toBe(0)
    } finally {
      await server.close()
    }
  })
})

function namesTheRequest(): Error {
  return new Error(`request to ${BASE}/ping/${MONITOR_ID} failed`)
}

function rejectsOnAbort(): FetchLike {
  return (_url, init) =>
    new Promise<PingHttpResponse>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(namesTheRequest()), { once: true })
    })
}

function mentionsTheId(result: PingResult): boolean {
  return inspect(result.error, { depth: 10 }).includes(MONITOR_ID)
}

describe('a failed check-in', () => {
  it('keeps what a refused request said about itself out of the result', async () => {
    recorder.respondWith({ rejectWith: namesTheRequest() })

    const result = await client({ retries: 0 }).ping('job')

    expect(result.outcome).toBe('network-error')
    expect(mentionsTheId(result)).toBe(false)
  })

  it('keeps it out when the deadline stopped the request', async () => {
    const result = await client({ fetch: rejectsOnAbort(), retries: 0, timeoutMs: 20 }).ping('job')

    expect(result.outcome).toBe('timeout')
    expect(mentionsTheId(result)).toBe(false)
  })

  it('keeps it out when the caller stopped the request', async () => {
    const controller = new AbortController()
    const settled = client({
      fetch: rejectsOnAbort(),
      retries: 0,
      timeoutMs: 5000,
      signal: controller.signal,
    }).ping('job')
    setTimeout(() => controller.abort(), 10)

    const result = await settled

    expect(result.outcome).toBe('aborted')
    expect(mentionsTheId(result)).toBe(false)
  })

  it('keeps it out when the answer itself could not be read', async () => {
    const unreadable: FetchLike = () =>
      Promise.resolve({
        get status(): number {
          throw namesTheRequest()
        },
      } as PingHttpResponse)

    const result = await client({ fetch: unreadable, retries: 0 }).ping('job')

    expect(result.outcome).toBe('unexpected')
    expect(mentionsTheId(result)).toBe(false)
  })
})

function transportRequest(fetch: FetchLike, extra: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: `${BASE}/ping/${MONITOR_ID}`,
    method: 'POST',
    headers: {},
    body: undefined,
    timeoutMs: 5000,
    bodyCapBytes: PING_RESPONSE_BODY_CAP_BYTES,
    attempts: attemptsFor(0),
    signal: undefined,
    fetch,
    ...extra,
  }
}

describe('the read loop', () => {
  it('gives the deadline a turn however large the pieces are', async () => {
    const piece = new Uint8Array(64).fill(0x78)
    let reads = 0
    const endless: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        get bodyUsed() {
          return reads > 0
        },
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({
            read: () => {
              reads += 1

              return Promise.resolve({ done: false, value: piece })
            },
            cancel: () => Promise.resolve(),
          }),
        },
      })

    const settled = await send(
      transportRequest(endless, { timeoutMs: 5, bodyCapBytes: API_RESPONSE_BODY_CAP_BYTES }),
    ).then(
      () => 'answered',
      (failure: unknown) => (failure instanceof TransportFailure ? failure.reason : 'thrown'),
    )

    expect(settled).toBe('timeout')
    expect(reads).toBeGreaterThanOrEqual(1024)
    expect(reads).toBeLessThan(API_RESPONSE_BODY_CAP_BYTES / piece.byteLength)
  })

  it.each([3000, 5 * 1024 * 1024])(
    'keeps no more of %i characters read whole than a streamed read would, cut on a character',
    async (characters) => {
      const wholeOnly: FetchLike = () =>
        Promise.resolve<PingHttpResponse>({
          status: 200,
          headers: { get: () => null },
          text: () => Promise.resolve('€'.repeat(characters)),
        })

      const answered = await send(transportRequest(wholeOnly))

      expect(answered.body).toBe('€'.repeat(Math.floor(PING_RESPONSE_BODY_CAP_BYTES / 3)))
    },
  )
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

  // The one shape where the answer is in hand and the body is not: the caller's own
  // cancellation lands while the reply is being read.
  it('is reported as an abort when it lands mid-read, not as the answer nobody finished', async () => {
    const controller = new AbortController()
    let pulled = 0
    const endsOnTheAbort: FetchLike = (_url, init) =>
      Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        get bodyUsed() {
          return pulled > 0
        },
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({
            read: () => {
              pulled += 1

              return new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                init.signal.addEventListener('abort', () => resolve({ done: true }), { once: true })
              })
            },
            cancel: () => Promise.resolve(),
          }),
        },
      })
    const settled = client({
      fetch: endsOnTheAbort,
      retries: 0,
      timeoutMs: 5000,
      signal: controller.signal,
    }).ping('job')
    setTimeout(() => controller.abort(), 10)

    const result = await settled

    expect(result.outcome).toBe('aborted')
    expect(result.ok).toBe(false)
  })

  // The deadline landing on an unread body keeps a server error, on the grounds that
  // reaching it does not un-answer one. A cancellation is the case where that does not hold.
  it('is reported as an abort even where the server error was never finished being read', async () => {
    const controller = new AbortController()
    let pulled = 0
    const neverSettles: FetchLike = () =>
      Promise.resolve<PingHttpResponse>({
        status: 503,
        headers: { get: () => null },
        get bodyUsed() {
          return pulled > 0
        },
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({
            read: () => {
              pulled += 1

              return new Promise<{ done: boolean; value?: Uint8Array }>(() => {})
            },
            cancel: () => Promise.resolve(),
          }),
        },
      })
    const settled = client({
      fetch: neverSettles,
      retries: 0,
      timeoutMs: 120,
      signal: controller.signal,
    }).ping('job')
    setTimeout(() => controller.abort(), 10)

    const result = await settled

    expect(result.outcome).toBe('aborted')
    expect(result.status).toBeUndefined()
  })

  it('is reported as an abort when it lands while a retry is being waited out', async () => {
    const controller = new AbortController()
    const answersSlowly: FetchLike = () =>
      detachedCountdown(40).reached.then<PingHttpResponse>(() => ({
        status: 503,
        headers: { get: () => null },
        bodyUsed: false,
        body: { cancel: () => Promise.resolve() },
        text: () => Promise.resolve('nope'),
      }))
    const settled = client({
      fetch: answersSlowly,
      retries: 1,
      timeoutMs: 60,
      signal: controller.signal,
    }).ping('job')
    setTimeout(() => controller.abort(), 45)

    const result = await settled

    expect(result.outcome).toBe('aborted')
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

  // The one path that reads the signal outside an attempt: a server error held over a budget
  // that ran out while its body was being read.
  function answersAnErrorItNeverFinishes(): FetchLike {
    return () =>
      Promise.resolve<PingHttpResponse>({
        status: 503,
        headers: { get: () => null },
        bodyUsed: false,
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({
            read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
            cancel: () => Promise.resolve(),
          }),
        },
      })
  }

  it.each([
    ['a value that only looks aborted', { aborted: true }],
    [
      'a signal whose state throws when read',
      {
        get aborted(): boolean {
          throw new Error('not today')
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    ],
  ])('holds a server error past %s, which never cancelled anything', async (_label, signal) => {
    const result = await client({
      fetch: answersAnErrorItNeverFinishes(),
      retries: 1,
      timeoutMs: 40,
      signal: signal as unknown as AbortSignal,
    }).ping('job')

    expect(result.outcome).toBe('server-error')
    expect(result.status).toBe(503)
  })

  it.each([
    [
      'whose listener registration throws when it is looked up',
      {
        aborted: false,
        get addEventListener(): never {
          throw new Error('not today')
        },
        removeEventListener: () => undefined,
      },
    ],
    [
      'that has been revoked',
      (() => {
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()

        return proxy
      })(),
    ],
  ])('sends the check-in past a signal %s, rather than reporting one never sent', async (_label, signal) => {
    const result = await client({ signal: signal as unknown as AbortSignal }).ping('job')

    expect(result.outcome).toBe('accepted')
    expect(recorder.pings).toHaveLength(1)
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
