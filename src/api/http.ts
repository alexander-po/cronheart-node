import { RETRY_FLOOR_DELAY_MS } from '../constants.js'
import { positiveOr } from '../numbers.js'
import { type Attempts } from '../transport/attempts.js'
import { countdown } from '../timer.js'
import { errorForStatus } from './classify.js'
import { API_BASE_PATH, CREATE_RETRY_BASE_DELAY_MS } from './constants.js'
import {
  ApiInvalidRequestError,
  ApiTransportError,
  type RequestDescriptor,
  isCronheartApiError,
} from './errors.js'
import { EMPTY_PROBLEM, parseProblem } from './problem.js'
import { type WireRequest, exchange } from './transport.js'
import type { RateLimitSnapshot, RequestOptions } from './types.js'
import { idempotencyKeyFor } from './validate.js'

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
  readonly separatelyThrottled?: boolean | undefined
}

export interface SessionSettings {
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs: number
  readonly attempts: Attempts
  readonly userAgent: string
  readonly fetch: WireRequest['fetch']
  readonly signal: WireRequest['signal']
}

interface Wire {
  readonly where: RequestDescriptor
  readonly url: string
  readonly body: string | undefined
  readonly idempotencyKey: string | undefined
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

// The monitor identifier is the check-in capability, and a descriptor is read back through
// a message, a log record and JSON.stringify alike. The address sent to is built separately.
const IDENTIFIER_SEGMENT =
  /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi

function forDisplay(path: string): string {
  return path.replace(IDENTIFIER_SEGMENT, '/{uuid}')
}

function encode(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined
  }

  let encoded: unknown

  try {
    encoded = JSON.stringify(body)
  } catch {
    encoded = undefined
  }

  if (typeof encoded !== 'string') {
    throw new ApiInvalidRequestError(
      'This request cannot be written as JSON. A value that is circular, a BigInt, or an object whose toJSON throws cannot be sent, and is refused rather than encoded.',
    )
  }

  return encoded
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
    wire: Wire,
    timeoutMs: number,
    options: RequestOptions | undefined,
  ): Promise<unknown> {
    const { where, body, idempotencyKey } = wire
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
      'User-Agent': settings.userAgent,
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = idempotencyKey
    }

    const answered = await exchange({
      url: wire.url,
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
        {
          request: where,
          rateLimit,
          deliversDownstream: endpoint.deliversDownstream,
          separatelyThrottled: endpoint.separatelyThrottled,
        },
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
  // request that waits between attempts. The wait spaces the attempts; it is far shorter
  // than the reservation the key holds, and deliberately so, since a wait long enough to
  // outlast that reservation would outlast the request's whole time budget. A 409 from
  // inside the window is therefore resolved by reading the resource back, never by waiting.
  function delayFor(attemptNumber: number, wire: Wire): number {
    return wire.idempotencyKey === undefined
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

  function mayRetry(endpoint: Endpoint, wire: Wire, error: unknown): boolean {
    if (endpoint.retry === 'never') {
      return false
    }

    if (endpoint.retry === 'with-idempotency-key' && wire.idempotencyKey === undefined) {
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
      const path = `${API_BASE_PATH}${endpoint.path}`
      const where: RequestDescriptor = { method: endpoint.method, path: forDisplay(path) }

      // Encoding is inside the seal too: a body the caller handed in is the last place a
      // rejection this client did not author could come from.
      try {
        const wire: Wire = {
          where,
          url: `${settings.baseUrl}${path}${queryOf(endpoint.query)}`,
          // Serialised once and retried byte for byte: the idempotency fingerprint covers
          // the raw body, so re-encoding the same object is a different request.
          body: encode(endpoint.body),
          idempotencyKey: idempotencyKeyFor(endpoint.idempotencyKey),
        }
        const budgetMs = positiveOr(options?.timeoutMs, settings.timeoutMs)
        const deadline = Date.now() + budgetMs
        let attemptNumber = 0

        for (;;) {
          if (attemptNumber > 0) {
            const waited = countdown(
              Math.max(0, Math.min(delayFor(attemptNumber, wire), deadline - Date.now())),
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
            return await attempt(endpoint, wire, remaining, options)
          } catch (error) {
            if (attemptNumber >= settings.attempts || !mayRetry(endpoint, wire, error)) {
              throw error
            }
          }
        }
      } catch (error) {
        throw sealed(error)
      }
    },
  }
}
