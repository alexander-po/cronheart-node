import { BODY_RELEASE_BUDGET_MS, MAX_RETRIES, RETRY_FLOOR_DELAY_MS } from '../constants.js'
import type { AbortSignalLike, FetchLike, PingHttpResponse } from '../ping/types.js'

export type TransportReason = 'timeout' | 'network-error' | 'unexpected'

const OUT_OF_BUDGET = 'the check-in ran out of its time budget'

const UNREACHABLE = 'the check-in could not reach the server'

const EXPIRED = Symbol('deadline')

export class TransportFailure extends Error {
  override readonly name = 'TransportFailure'

  readonly reason: TransportReason

  readonly attempts: number

  constructor(reason: TransportReason, attempts: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.reason = reason
    this.attempts = attempts
  }
}

export interface TransportRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly timeoutMs: number
  readonly retries: number
  readonly signal: AbortSignalLike | undefined
  readonly fetch: FetchLike | undefined
}

export interface TransportResult {
  readonly status: number
  readonly body: string
  readonly retryAfter: string | null
  readonly attempts: number
}

interface ReadResponse {
  readonly status: number
  readonly body: string
  readonly retryAfter: string | null
}

export function ambientFetch(): FetchLike | undefined {
  const host = globalThis as { fetch?: unknown }

  return typeof host.fetch === 'function'
    ? ((host.fetch as (...args: never[]) => unknown).bind(globalThis) as FetchLike)
    : undefined
}

function isAbortSignalLike(value: unknown): value is AbortSignalLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as AbortSignalLike).addEventListener === 'function' &&
    typeof (value as AbortSignalLike).removeEventListener === 'function'
  )
}

function unrefIfPossible(timer: unknown): void {
  if (typeof (timer as { unref?: () => void } | undefined)?.unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function releaseBody(response: PingHttpResponse): Promise<void> {
  let handle: ReturnType<typeof setTimeout> | undefined

  try {
    const stream = response.body

    if (
      response.bodyUsed === true ||
      stream === null ||
      stream === undefined ||
      typeof stream.cancel !== 'function'
    ) {
      return
    }

    // Nothing waits on a release, so its deadline must not be able to hold the process
    // open — and a stream that never finishes releasing must not hold the check-in.
    const gaveUp = new Promise<typeof EXPIRED>((resolve) => {
      handle = setTimeout(() => resolve(EXPIRED), BODY_RELEASE_BUDGET_MS)
      unrefIfPossible(handle)
    })

    await Promise.race([stream.cancel(), gaveUp])
  } catch {
    // A body that refuses to be released is not a reason to fail a check-in.
  } finally {
    if (handle !== undefined) {
      clearTimeout(handle)
    }
  }
}

async function readResponse(response: PingHttpResponse): Promise<ReadResponse> {
  try {
    const status = response.status

    if (typeof status !== 'number' || !Number.isFinite(status)) {
      throw new TransportFailure(
        'unexpected',
        1,
        'the transport resolved to something that is not an HTTP response',
      )
    }

    const headers = response.headers
    const retryAfter = typeof headers?.get === 'function' ? headers.get('retry-after') : null

    let body = ''

    try {
      if (typeof response.text === 'function') {
        body = await response.text()
      }
    } catch {
      body = ''
    }

    return { status, body: typeof body === 'string' ? body : '', retryAfter }
  } finally {
    await releaseBody(response)
  }
}

function relayAbort(
  signal: unknown,
  controller: AbortController,
  relay: () => void,
): AbortSignalLike | undefined {
  const caller = isAbortSignalLike(signal) ? signal : undefined

  if (caller === undefined) {
    return undefined
  }

  try {
    if (caller.aborted) {
      controller.abort()

      return undefined
    }

    caller.addEventListener('abort', relay, { once: true })

    return caller
  } catch {
    // A hand-built signal is an input like any other: ignoring one that throws costs
    // the caller their cancellation, while trusting it would cost the check-in.
    return undefined
  }
}

function stopRelaying(caller: AbortSignalLike | undefined, relay: () => void): void {
  try {
    caller?.removeEventListener('abort', relay)
  } catch {
    // The check-in is already over; a signal that throws on the way out cannot change it.
  }
}

async function attemptOnce(
  request: TransportRequest,
  send: FetchLike,
  budgetMs: number,
): Promise<ReadResponse> {
  const controller = new AbortController()
  const relay = (): void => {
    controller.abort()
  }
  let expired = false
  let handle: ReturnType<typeof setTimeout> | undefined
  let listening: AbortSignalLike | undefined

  try {
    const reached = new Promise<typeof EXPIRED>((resolve) => {
      handle = setTimeout(() => {
        expired = true
        controller.abort()
        resolve(EXPIRED)
      }, budgetMs)
    })

    listening = relayAbort(request.signal, controller, relay)

    let response: PingHttpResponse
    let dispatched: Promise<PingHttpResponse> | undefined

    try {
      dispatched = send(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        // A followed redirect turns a POST into a GET and drops the body with it, so a
        // base URL that moved would go on answering while carrying nothing.
        redirect: 'manual',
        signal: controller.signal,
      })
      // The deadline is raced rather than trusted to the abort signal: a transport
      // that ignores the signal would otherwise hold the job open indefinitely.
      const raced = await Promise.race([dispatched, reached])

      if (raced === EXPIRED) {
        throw new TransportFailure('timeout', 1, OUT_OF_BUDGET)
      }

      response = raced
    } catch (cause) {
      if (expired && dispatched !== undefined) {
        void dispatched.then(
          (late) => releaseBody(late),
          () => undefined,
        )
      }

      if (cause instanceof TransportFailure) {
        throw cause
      }

      throw expired || controller.signal.aborted
        ? new TransportFailure('timeout', 1, OUT_OF_BUDGET, cause)
        : new TransportFailure('network-error', 1, UNREACHABLE, cause)
    }

    try {
      // The same deadline covers the read: a transport that ignores the signal ignores
      // it while handing the body over as readily as while opening the connection.
      const read = await Promise.race([readResponse(response), reached])

      if (read === EXPIRED) {
        void releaseBody(response)

        throw new TransportFailure('timeout', 1, OUT_OF_BUDGET)
      }

      return read
    } catch (cause) {
      throw cause instanceof TransportFailure
        ? cause
        : new TransportFailure('unexpected', 1, 'the transport response could not be read', cause)
    }
  } finally {
    if (handle !== undefined) {
      clearTimeout(handle)
    }

    stopRelaying(listening, relay)
  }
}

export async function send(request: TransportRequest): Promise<TransportResult> {
  const dispatch = request.fetch ?? ambientFetch()

  if (dispatch === undefined) {
    throw new TransportFailure(
      'unexpected',
      0,
      'this runtime has no fetch — pass one to createPingClient',
    )
  }

  const deadline = Date.now() + request.timeoutMs
  const maxAttempts = Math.min(Math.max(1, request.retries + 1), MAX_RETRIES + 1)
  let attempt = 0
  let last: TransportFailure | undefined

  while (attempt < maxAttempts) {
    if (attempt > 0) {
      await pause(Math.min(RETRY_FLOOR_DELAY_MS, Math.max(0, deadline - Date.now())))
    }

    attempt += 1
    const budget = deadline - Date.now()

    if (budget <= 0) {
      throw new TransportFailure('timeout', attempt - 1, OUT_OF_BUDGET, last)
    }

    try {
      const outcome = await attemptOnce(request, dispatch, budget)

      if (outcome.status >= 500 && attempt < maxAttempts) {
        continue
      }

      return { ...outcome, attempts: attempt }
    } catch (error) {
      const failure =
        error instanceof TransportFailure
          ? new TransportFailure(error.reason, attempt, error.message, error.cause)
          : new TransportFailure('network-error', attempt, UNREACHABLE, error)

      if (failure.reason !== 'network-error' || attempt >= maxAttempts) {
        throw failure
      }

      last = failure
    }
  }

  throw last ?? new TransportFailure('network-error', attempt, 'the check-in exhausted its attempts')
}
