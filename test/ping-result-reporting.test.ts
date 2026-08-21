import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PING_DUPLICATE_BODY, PING_OUTCOMES } from '../src/ping/outcome.js'
import { describePingResult } from '../src/ping/describe.js'
import { createPingClient } from '../src/ping/client.js'
import type { PingOutcome } from '../src/ping/outcome.js'
import type { FetchLike, PingClientOptions, PingResult } from '../src/ping/types.js'
import { clearWarnings, createPingRecorder } from '../src/testing.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000d1'

const OTHER_ID = '00000000-0000-4000-8000-0000000000d2'

const BASE_URL = 'https://example.invalid'

let warnings: string[]

function clientWith(options: PingClientOptions = {}): ReturnType<typeof createPingClient> {
  return createPingClient({
    baseUrl: BASE_URL,
    env: {},
    monitors: { job: MONITOR_ID, other: OTHER_ID },
    retries: 0,
    timeoutMs: 200,
    ...options,
  })
}

function refusing(): PingClientOptions['fetch'] {
  return () => Promise.reject(new TypeError('fetch failed'))
}

const rejectingOnAbort: FetchLike = (_url, init) =>
  init.signal.aborted
    ? Promise.reject(new Error('the caller stopped it'))
    : new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('the caller stopped it'))
        })
      })

beforeEach(() => {
  clearWarnings()
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a check-in that never reached the server says so without a result callback', () => {
  it('warns on a refused connection, which no configuration mistake produced', async () => {
    const client = clientWith({ fetch: refusing() })

    const result = await client.ping('job')

    expect(result.outcome).toBe('network-error')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cronheart:')
    expect(warnings[0]).toContain('job')
  })

  it('says nothing at all when the check-in was recorded, so the warner is not simply always on', async () => {
    const failing = await clientWith({ fetch: refusing() }).ping('job')

    expect(failing.outcome).toBe('network-error')
    expect(warnings).toHaveLength(1)

    const recorded = await clientWith({
      fetch: createPingRecorder({ status: 200, body: 'OK' }).fetch,
    }).ping('other')

    expect(recorded.outcome).toBe('accepted')
    expect(warnings).toHaveLength(1)
  })

  it('speaks once per process for one cause on one monitor, however often the job runs', async () => {
    const client = clientWith({ fetch: refusing() })

    await client.ping('job')
    await client.ping('job')
    await client.ping('job')

    expect(warnings).toHaveLength(1)
  })

  it('still speaks for a second monitor and for a second cause, so once is not once overall', async () => {
    const failing = clientWith({ fetch: refusing() })

    await failing.ping('job')
    await failing.ping('other')

    const refused = clientWith({
      fetch: createPingRecorder({ status: 503, body: 'nope' }).fetch,
    })

    await refused.ping('job')

    expect(warnings).toHaveLength(3)
    expect(new Set(warnings).size).toBe(3)
  })

  it('hands a transport failure to onResult instead of the console when one is given', async () => {
    const seen: PingResult[] = []
    const client = clientWith({ fetch: refusing(), onResult: (result) => seen.push(result) })

    await client.ping('job')

    expect(seen.map((result) => result.outcome)).toEqual(['network-error'])
    expect(warnings).toEqual([])
  })
})

describe('the result carries whether the server answered', () => {
  it('separates a request that left the process from one the server replied to', async () => {
    const client = clientWith({ fetch: refusing() })

    const result = await client.ping('job')

    expect(result.attempts).toBe(1)
    expect(result.sent).toBe(true)
    expect(result.answered).toBe(false)
    expect(result.status).toBeUndefined()
  })

  it('reports an answer for a refusal the server did send, not only for one it accepted', async () => {
    const client = clientWith({ fetch: createPingRecorder({ status: 404, body: 'no' }).fetch })

    const result = await client.ping('job')

    expect(result.ok).toBe(false)
    expect(result.answered).toBe(true)
    expect(result.status).toBe(404)
  })

  it('answers nothing for a check-in that was never sent', async () => {
    const client = clientWith({ fetch: refusing(), disabled: true })

    const result = await client.ping('job')

    expect(result.outcome).toBe('disabled')
    expect(result.attempts).toBe(0)
    expect(result.sent).toBe(false)
    expect(result.answered).toBe(false)
  })
})

// Driven through the client rather than assembled by hand: describePingResult falls back to
// a generic line when message is unset, so a hand-built result proves the fallback and never
// the sentences the warner exists to speak.
async function resultFor(outcome: PingOutcome): Promise<PingResult> {
  if (outcome === 'disabled') {
    return clientWith({ fetch: refusing(), disabled: true }).ping('job')
  }

  if (outcome === 'suppressed') {
    return clientWith({ fetch: refusing() }).ping('nothing-configures-this')
  }

  if (outcome === 'network-error') {
    return clientWith({ fetch: refusing() }).ping('job')
  }

  if (outcome === 'timeout') {
    return clientWith({ fetch: createPingRecorder({ hang: true }).fetch, timeoutMs: 40 }).ping('job')
  }

  if (outcome === 'aborted') {
    const cancelled = AbortSignal.abort()

    return clientWith({ fetch: rejectingOnAbort, signal: cancelled }).ping('job')
  }

  const stub = STUB_FOR[outcome]

  return clientWith({ fetch: createPingRecorder(stub).fetch }).ping('job')
}

const STUB_FOR: Readonly<Record<string, { status: number; body: string }>> = {
  accepted: { status: 200, body: 'OK' },
  duplicate: { status: 200, body: PING_DUPLICATE_BODY },
  paused: { status: 410, body: 'Monitor paused' },
  'not-found': { status: 404, body: 'Monitor not found' },
  'rate-limited': { status: 429, body: 'Too many' },
  'server-error': { status: 500, body: 'boom' },
  unexpected: { status: 400, body: 'Bad request' },
}

// The three the client is deliberately quiet about: two are check-ins the server recorded,
// and the third is a cancellation the caller asked for and already knows about.
const NOTHING_TO_ANNOUNCE = new Set<PingOutcome>(['accepted', 'duplicate', 'aborted'])

describe('every outcome the client can reach renders to a sentence a consumer can log', () => {
  let results: Map<PingOutcome, PingResult>

  beforeEach(async () => {
    results = new Map()

    for (const outcome of PING_OUTCOMES) {
      results.set(outcome, await resultFor(outcome))
    }
  })

  it('reaches all twelve through the client, so nothing below is asserted about a shape only', () => {
    expect(PING_OUTCOMES).toHaveLength(12)
    expect([...results].filter(([wanted, result]) => result.outcome !== wanted)).toEqual([])
  })

  it('writes the sentence the warner speaks for every outcome but the three it is quiet about', () => {
    const silent = [...results].filter(([, result]) => result.message === undefined)

    expect(silent.map(([outcome]) => outcome).sort()).toEqual([...NOTHING_TO_ANNOUNCE].sort())
  })

  it('describes the quiet three as well, which is what a result callback needs and the warner does not', () => {
    const described = [...results].map(([, result]) => describePingResult(result))

    expect(described.filter((line) => line.split(' ').length < 4)).toEqual([])
    expect(described.filter((line) => !line.includes('job') && !line.includes('nothing'))).toEqual([])
  })

  it('prefers the sentence the client wrote over the generic one', () => {
    const failed = results.get('network-error') as PingResult

    expect(failed.message).toBeDefined()
    expect(describePingResult(failed)).toBe(failed.message)
  })
})
