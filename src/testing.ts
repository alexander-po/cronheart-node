import type { FetchLike, PingHttpResponse, PingRequestInit } from './ping/types.js'
import { detachedCountdown } from './timer.js'

export { clearWarnings } from './ping/warn.js'

export interface RecordedPing {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly redirect: string | undefined
  readonly monitorId: string
  readonly action: string | null
}

export interface StubResponse {
  readonly status?: number | undefined
  readonly body?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly delayMs?: number | undefined
  readonly hang?: boolean | undefined
  readonly rejectWith?: unknown
}

export type Responder = (request: RecordedPing, attempt: number) => StubResponse

export interface PingRecorder {
  readonly fetch: FetchLike
  readonly pings: readonly RecordedPing[]
  readonly undrainedBodies: number
  respondWith(responder: Responder | StubResponse): void
  reset(): void
}

const PING_PATH = /\/ping\/([^/?#]+)(?:\/([^/?#]+))?$/

function describeRequest(url: string, init: PingRequestInit): RecordedPing {
  const match = PING_PATH.exec(url)

  return {
    url,
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    redirect: init.redirect,
    monitorId: match?.[1] ?? '',
    action: match?.[2] ?? null,
  }
}

export function createPingRecorder(initial?: Responder | StubResponse): PingRecorder {
  const pings: RecordedPing[] = []
  const drained: { consumed: boolean }[] = []
  let responder: Responder = () => ({})

  const recorder: PingRecorder = {
    fetch: (url, init) => {
      const request = describeRequest(url, init)
      const attempt = pings.filter((ping) => ping.url === request.url).length + 1
      pings.push(request)

      const stub = responder(request, attempt)

      if (stub.hang === true) {
        return new Promise<PingHttpResponse>(() => {})
      }

      if ('rejectWith' in stub) {
        return Promise.reject(stub.rejectWith)
      }

      const state = { consumed: false }
      drained.push(state)

      const response: PingHttpResponse = {
        status: stub.status ?? 200,
        headers: { get: (name) => stub.headers?.[name.toLowerCase()] ?? null },
        get bodyUsed() {
          return state.consumed
        },
        body: {
          cancel: () => {
            state.consumed = true

            return Promise.resolve()
          },
        },
        text: async () => {
          state.consumed = true

          return stub.body ?? 'OK'
        },
      }

      return stub.delayMs === undefined
        ? Promise.resolve(response)
        : detachedCountdown(stub.delayMs).reached.then(() => response)
    },
    get pings() {
      return pings
    },
    get undrainedBodies() {
      return drained.filter((state) => !state.consumed).length
    },
    respondWith: (next) => {
      responder = typeof next === 'function' ? next : () => next
    },
    reset: () => {
      pings.length = 0
      drained.length = 0
    },
  }

  if (initial !== undefined) {
    recorder.respondWith(initial)
  }

  return recorder
}
