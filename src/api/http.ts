import { RETRY_FLOOR_DELAY_MS } from '../constants.js'
import { countdown } from '../timer.js'
import { errorForStatus } from './classify.js'
import { API_BASE_PATH, CREATE_RETRY_BASE_DELAY_MS } from './constants.js'
import { ApiTransportError, type RequestDescriptor, isCronheartApiError } from './errors.js'
import { EMPTY_PROBLEM, parseProblem } from './problem.js'
import { type WireRequest, exchange } from './transport.js'
import type { RateLimitSnapshot, RequestOptions } from './types.js'

// Whether a repeat of this request is safe, decided per route rather than per verb: a
// rotate leaves a different resource behind every time it runs, and a channel test sends a
// real message and spends a burst allowance, while a pause repeated converges.
export type RetryPolicy = 'safe' | 'never' | 'with-idempotency-key'

export interface Endpoint {
  readonly method: string
  readonly path: string
  readonly retry: RetryPolicy
  readonly query?: Readonly<Record<string, string | number | undefined>> | undefined
  readonly body?: unknown
  readonly idempotencyKey?: string | undefined
  readonly deliversDownstream?: boolean | undefined
}

export interface SessionSettings {
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly retries: number
  readonly userAgent: string
  readonly fetch: WireRequest['fetch']
  readonly signal: WireRequest['signal']
}

export interface Session {
  send(endpoint: Endpoint, options: RequestOptions | undefined): Promise<unknown>
  readonly rateLimit: RateLimitSnapshot | undefined
}

function integerHeader(value: string | null): number | undefined {
  if (value === null || !/^[0-9]+$/.test(value.trim())) {
    return undefined
  }

  const parsed = Number(value.trim())

  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function queryOf(query: Endpoint['query']): string {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      params.set(key, String(value))
    }
  }

  const encoded = params.toString()

  return encoded === '' ? '' : `?${encoded}`
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function createSession(settings: SessionSettings): Session {
  let lastSeen: RateLimitSnapshot | undefined

  function rateLimitFrom(header: (name: string) => string | null): RateLimitSnapshot | undefined {
    const snapshot: RateLimitSnapshot = {
      limit: integerHeader(header('x-ratelimit-limit')),
      remaining: integerHeader(header('x-ratelimit-remaining')),
      resetAt: integerHeader(header('x-ratelimit-reset')),
    }

    // Two statuses carry no rate-limit headers at all, so the previous reading is kept
    // rather than replaced with three undefined fields.
    if (snapshot.limit === undefined && snapshot.remaining === undefined) {
      return lastSeen
    }

    lastSeen = snapshot

    return snapshot
  }

  async function attempt(
    endpoint: Endpoint,
    where: RequestDescriptor,
    body: string | undefined,
    timeoutMs: number,
    options: RequestOptions | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      'User-Agent': settings.userAgent,
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (endpoint.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = endpoint.idempotencyKey
    }

    const answered = await exchange({
      url: `${settings.baseUrl}${where.path}${queryOf(endpoint.query)}`,
      method: endpoint.method,
      headers,
      body,
      timeoutMs,
      signal: options?.signal ?? settings.signal,
      fetch: settings.fetch,
    })
    const rateLimit = rateLimitFrom(answered.header)

    if (answered.status < 200 || answered.status >= 300) {
      const problem = parseProblem(answered.body)
      const retryAfter = integerHeader(answered.header('retry-after'))

      throw errorForStatus(
        answered.status,
        retryAfter === undefined ? problem : { ...problem, retryAfterSeconds: retryAfter },
        where,
        rateLimit,
      )
    }

    if (answered.status === 204 || answered.body.trim() === '') {
      return undefined
    }

    try {
      return JSON.parse(answered.body)
    } catch {
      throw new ApiTransportError(
        'unparseable',
        `The service answered ${where.method} ${where.path} with HTTP ${answered.status} and a body that is not JSON.`,
        { status: answered.status, request: where, rateLimit, problem: EMPTY_PROBLEM },
      )
    }
  }

  // A create is retried only when the caller supplied an idempotency key, and it is the one
  // request that waits between attempts: the reservation the key takes stays pending, so a
  // retry sent immediately is refused as a conflict while the resource was in fact created.
  function delayFor(attemptNumber: number, endpoint: Endpoint): number {
    return endpoint.idempotencyKey === undefined
      ? RETRY_FLOOR_DELAY_MS
      : CREATE_RETRY_BASE_DELAY_MS * attemptNumber
  }

  // The last gate before a rejection leaves this client. Every throw above already produces
  // a branded error; this is what makes catching the base type exhaustive even if one day
  // one of them does not, rather than leaking a TypeError from a line nobody thought about.
  function sealed(error: unknown): unknown {
    return isCronheartApiError(error)
      ? error
      : new ApiTransportError('unexpected', 'The request failed in a way this client did not model.')
  }

  function mayRetry(endpoint: Endpoint, error: unknown): boolean {
    if (endpoint.retry === 'never') {
      return false
    }

    if (endpoint.retry === 'with-idempotency-key' && endpoint.idempotencyKey === undefined) {
      return false
    }

    if (error instanceof ApiTransportError) {
      return error.reason === 'network-error'
    }

    const status = (error as { status?: unknown }).status

    return typeof status === 'number' && status >= 500
  }

  return {
    get rateLimit() {
      return lastSeen
    },
    send: async (endpoint, options) => {
      const where: RequestDescriptor = {
        method: endpoint.method,
        path: `${API_BASE_PATH}${endpoint.path}`,
        deliversDownstream: endpoint.deliversDownstream,
      }
      // Serialised once and retried byte for byte: the idempotency fingerprint covers the
      // raw body, so re-encoding the same object is a different request under the same key.
      const body = endpoint.body === undefined ? undefined : JSON.stringify(endpoint.body)
      const budgetMs = positiveOr(options?.timeoutMs, settings.timeoutMs)
      const deadline = Date.now() + budgetMs
      const maxAttempts = settings.retries + 1
      let attemptNumber = 0

      for (;;) {
        if (attemptNumber > 0) {
          const waited = countdown(
            Math.max(0, Math.min(delayFor(attemptNumber, endpoint), deadline - Date.now())),
          )

          try {
            await waited.reached
          } finally {
            waited.cancel()
          }
        }

        attemptNumber += 1
        const remaining = deadline - Date.now()

        if (remaining <= 0) {
          throw new ApiTransportError(
            'timeout',
            `The request ran out of its time budget after ${attemptNumber - 1} attempt(s).`,
            { request: where },
          )
        }

        try {
          return await attempt(endpoint, where, body, remaining, options)
        } catch (error) {
          if (attemptNumber >= maxAttempts || !mayRetry(endpoint, error)) {
            throw sealed(error)
          }
        }
      }
    },
  }
}
