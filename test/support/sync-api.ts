import { createCronheartApi } from '../../src/api/client.js'
import type { CronheartApi, CronheartApiOptions } from '../../src/api/types.js'
import type { PingHttpResponse, PingRequestInit } from '../../src/ping/types.js'
import { API_KEY, BASE_URL } from './api-recorder.js'
import type { MonitorStore, StoreRequest } from './monitor-store.js'

export { API_KEY, BASE_URL }

function requestFrom(url: string, init: PingRequestInit): StoreRequest {
  const parsed = new URL(url)
  const query: Record<string, string> = {}

  for (const [key, value] of parsed.searchParams) {
    query[key] = value
  }

  return {
    method: init.method,
    path: parsed.pathname,
    query,
    body: init.body === undefined ? undefined : JSON.parse(init.body),
    idempotencyKey: init.headers['Idempotency-Key'],
  }
}

export function transportFor(store: MonitorStore) {
  return (url: string, init: PingRequestInit): Promise<PingHttpResponse> => {
    const reply = store.handle(requestFrom(url, init))
    const text = reply.json === undefined ? '' : JSON.stringify(reply.json)

    return Promise.resolve({
      status: reply.status,
      headers: { get: () => null },
      bodyUsed: false,
      body: { cancel: () => Promise.resolve() },
      text: () => Promise.resolve(text),
    })
  }
}

// Answers through the real management client rather than a hand-written stand-in for it, so
// hydration, validation, paging and the identifier asymmetry are all in the path under test.
export function apiFor(store: MonitorStore, overrides: CronheartApiOptions = {}): CronheartApi {
  const transport = transportFor(store)

  return createCronheartApi({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    env: {},
    retries: 0,
    fetch: transport,
    ...overrides,
  })
}

export function bodiesSentTo(store: MonitorStore, method: string): readonly unknown[] {
  return store.requests.filter((request) => request.method === method).map((request) => request.body)
}
