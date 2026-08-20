import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_RETRIES, RETRY_FLOOR_DELAY_MS } from '../src/constants.js'
import { createPingClient } from '../src/ping/client.js'
import type { PingClientOptions } from '../src/ping/types.js'
import { createPingRecorder } from '../src/testing.js'
import { InvalidBaseUrlError } from '../src/wiring/errors.js'

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

beforeEach(() => {
  recorder = createPingRecorder()
})

describe('the retry count', () => {
  it('is capped, so a mistyped configuration cannot flood the service it monitors', async () => {
    recorder.respondWith({ status: 500, body: 'boom' })

    const result = await client({ retries: 9_999_999, timeoutMs: 1000 }).ping('job')

    expect(recorder.pings).toHaveLength(MAX_RETRIES + 1)
    expect(result.attempts).toBe(MAX_RETRIES + 1)
  })

  it('is capped the same way when it arrives from the environment', async () => {
    recorder.respondWith({ status: 500, body: 'boom' })

    await client({ env: { CRONHEART_RETRIES: '9999999' }, timeoutMs: 1000 }).ping('job')

    expect(recorder.pings).toHaveLength(MAX_RETRIES + 1)
  })

  it('leaves a floor of delay between attempts rather than retrying in a tight loop', async () => {
    recorder.respondWith({ status: 500, body: 'boom' })
    const started = performance.now()

    await client({ retries: 1, timeoutMs: 1000 }).ping('job')

    expect(recorder.pings).toHaveLength(2)
    expect(performance.now() - started).toBeGreaterThanOrEqual(RETRY_FLOOR_DELAY_MS)
  })

  it('spends that delay inside the timeout budget rather than on top of it', async () => {
    recorder.respondWith({ status: 500, body: 'boom' })
    const started = Date.now()

    await client({ retries: MAX_RETRIES, timeoutMs: 120 }).ping('job')

    expect(recorder.pings.length).toBeLessThan(MAX_RETRIES + 1)
    expect(Date.now() - started).toBeLessThan(120 * 3)
  })
})

describe('the base URL', () => {
  it.each([
    '::: not a url :::',
    'host.example',
    'ftp://host.example',
    'https://host.example/?tenant=a',
    'https://host.example#fragment',
    'https://someone:hunter2@host.example',
    'https://someone@host.example',
    'http://host.example',
    'http://198.51.100.7',
  ])('is refused at wiring time when a check-in could not reach the route: %s', (baseUrl) => {
    expect(() =>
      createPingClient({ baseUrl, env: {}, monitors: { job: MONITOR_ID } }),
    ).toThrow(InvalidBaseUrlError)
  })

  // The excerpt a wrapper sends is a job's stderr, and a base URL is set by an environment
  // variable: plain http to somewhere else on the network would put it in the clear.
  it.each(['http://localhost:8080', 'http://127.0.0.1:9000', 'http://[::1]:9000'])(
    'is allowed over plain http on the loopback address a developer runs on: %s',
    (baseUrl) => {
      expect(() =>
        createPingClient({ baseUrl, env: {}, monitors: { job: MONITOR_ID } }),
      ).not.toThrow()
    },
  )

  it('says which URL it refused without repeating the credential that was in it', () => {
    expect(() =>
      createPingClient({
        baseUrl: 'https://someone:hunter2-not-real@host.example',
        env: {},
        monitors: { job: MONITOR_ID },
      }),
    ).toThrow(/host\.example/)
    expect(() =>
      createPingClient({
        baseUrl: 'https://someone:hunter2-not-real@host.example',
        env: {},
        monitors: { job: MONITOR_ID },
      }),
    ).not.toThrow(/hunter2-not-real/)
  })

  it('is refused the same way when it arrives from the environment', () => {
    expect(() =>
      createPingClient({
        env: { CRONHEART_URL: 'https://host.example/?tenant=a' },
        monitors: { job: MONITOR_ID },
      }),
    ).toThrow(InvalidBaseUrlError)
  })

  it('keeps a path prefix, because a reverse proxy in front of the service is legitimate', async () => {
    const sdk = createPingClient({
      baseUrl: 'https://host.example/cronheart/',
      fetch: recorder.fetch,
      env: {},
      monitors: { job: MONITOR_ID },
    })

    await sdk.ping('job')

    expect(recorder.pings[0]?.url).toBe(`https://host.example/cronheart/ping/${MONITOR_ID}`)
  })
})

describe('a redirect', () => {
  it('is not followed, because the specification turns a redirected POST into a bodiless GET', async () => {
    await client().fail('job', { body: 'stderr tail' })

    expect(recorder.pings).toHaveLength(1)
    expect(recorder.pings[0]?.redirect).toBe('manual')
  })
})
