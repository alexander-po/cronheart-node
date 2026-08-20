import { BODY_RELEASE_BUDGET_MS, RETRY_FLOOR_DELAY_MS } from '../constants.js'
import type { AbortSignalLike, FetchLike, PingHttpResponse } from '../ping/types.js'
import { type Countdown, countdown, detachedCountdown } from '../timer.js'
import type { Attempts } from './attempts.js'

export type TransportReason = 'timeout' | 'aborted' | 'network-error' | 'unexpected'

const OUT_OF_BUDGET = 'the check-in ran out of its time budget'

const UNREACHABLE = 'the check-in could not reach the server'

const CANCELLED = 'the caller aborted the check-in'

const EXPIRED = Symbol('deadline')

export class TransportFailure extends Error {
  override readonly name = 'TransportFailure'

  readonly reason: TransportReason

  readonly attempts: number

  constructor(reason: TransportReason, message: string, cause?: unknown, attempts = 0) {
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
  readonly attempts: Attempts
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
  const globals = globalThis as { fetch?: unknown }

  return typeof globals.fetch === 'function'
    ? ((globals.fetch as (...args: never[]) => unknown).bind(globalThis) as FetchLike)
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

async function releaseBody(response: PingHttpResponse): Promise<void> {
  let gaveUp: Countdown | undefined

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

    // A stream that never finishes releasing must not hold the check-in.
    gaveUp = detachedCountdown(BODY_RELEASE_BUDGET_MS)

    await Promise.race([stream.cancel(), gaveUp.reached])
  } catch {
  } finally {
    gaveUp?.cancel()
  }
}

async function readResponse(response: PingHttpResponse): Promise<ReadResponse> {
  try {
    const status = response.status

    if (typeof status !== 'number' || !Number.isFinite(status)) {
      throw new TransportFailure(
        'unexpected',
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

function relayAbort(signal: unknown, relay: () => void): AbortSignalLike | undefined {
  const caller = isAbortSignalLike(signal) ? signal : undefined

  if (caller === undefined) {
    return undefined
  }

  try {
    if (caller.aborted) {
      relay()

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
  } catch {}
}

async function attemptOnce(
  request: TransportRequest,
  transport: FetchLike,
  budgetMs: number,
): Promise<ReadResponse> {
  const controller = new AbortController()
  let expired = false
  let stoppedBy: 'deadline' | 'caller' | undefined
  const stop = (source: 'deadline' | 'caller'): void => {
    stoppedBy ??= source
    controller.abort()
  }
  const relay = (): void => {
    stop('caller')
  }
  // A shutdown the caller asked for is not a deadline they never configured, and reporting
  // it as one hides a clean cancellation inside a failure count.
  const gaveUp = (cause?: unknown): TransportFailure =>
    stoppedBy === 'caller'
      ? new TransportFailure('aborted', CANCELLED, cause, 1)
      : new TransportFailure('timeout', OUT_OF_BUDGET, cause, 1)
  const deadline = countdown(budgetMs)
  let listening: AbortSignalLike | undefined

  try {
    const reached: Promise<typeof EXPIRED> = deadline.reached.then(() => {
      expired = true
      stop('deadline')

      return EXPIRED
    })

    listening = relayAbort(request.signal, relay)

    let response: PingHttpResponse
    let dispatched: Promise<PingHttpResponse> | undefined

    try {
      dispatched = transport(request.url, {
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
        throw gaveUp()
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
        ? gaveUp(cause)
        : new TransportFailure('network-error', UNREACHABLE, cause, 1)
    }

    try {
      // The same deadline covers the read: a transport that ignores the signal ignores
      // it while handing the body over as readily as while opening the connection.
      const read = await Promise.race([readResponse(response), reached])

      if (read === EXPIRED) {
        void releaseBody(response)

        throw gaveUp()
      }

      return read
    } catch (cause) {
      throw cause instanceof TransportFailure
        ? cause
        : new TransportFailure('unexpected', 'the transport response could not be read', cause, 1)
    }
  } finally {
    deadline.cancel()
    stopRelaying(listening, relay)
  }
}

export async function send(request: TransportRequest): Promise<TransportResult> {
  const transport = request.fetch ?? ambientFetch()

  if (transport === undefined) {
    throw new TransportFailure(
      'unexpected',
      'this runtime has no fetch — pass one to createPingClient',
    )
  }

  const deadline = Date.now() + request.timeoutMs
  let attempt = 0
  let last: TransportFailure | undefined
  let answered: ReadResponse | undefined

  while (attempt < request.attempts) {
    if (attempt > 0) {
      await countdown(Math.min(RETRY_FLOOR_DELAY_MS, Math.max(0, deadline - Date.now()))).reached
    }

    attempt += 1
    const budget = deadline - Date.now()

    if (budget <= 0) {
      // A server that answered and then ran the budget out is a different report from a
      // server that was never reached, and the retried answer is the more informative one.
      if (answered !== undefined) {
        return { ...answered, attempts: attempt - 1 }
      }

      throw new TransportFailure('timeout', OUT_OF_BUDGET, last, attempt - 1)
    }

    try {
      const outcome = await attemptOnce(request, transport, budget)

      if (outcome.status >= 500 && attempt < request.attempts) {
        answered = outcome

        continue
      }

      return { ...outcome, attempts: attempt }
    } catch (error) {
      const failure =
        error instanceof TransportFailure
          ? new TransportFailure(error.reason, error.message, error.cause, attempt)
          : new TransportFailure('network-error', UNREACHABLE, error, attempt)

      if (failure.reason !== 'network-error' || attempt >= request.attempts) {
        throw failure
      }

      last = failure
    }
  }

  throw (
    last ??
    new TransportFailure('network-error', 'the check-in exhausted its attempts', undefined, attempt)
  )
}
