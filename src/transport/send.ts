import type { AbortSignalLike, FetchLike, PingHttpResponse } from '../ping/types.js'

export type TransportReason = 'timeout' | 'network-error' | 'unexpected'

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

// A timer the caller never cancels would hold the event loop open past the end of
// the job. Losing an in-flight check-in at process exit is what flush() is for.
function unrefIfPossible(timer: unknown): void {
  if (typeof (timer as { unref?: () => void } | undefined)?.unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }
}

async function releaseBody(response: PingHttpResponse): Promise<void> {
  try {
    const stream = response.body

    if (
      response.bodyUsed !== true &&
      stream !== null &&
      stream !== undefined &&
      typeof stream.cancel === 'function'
    ) {
      await stream.cancel()
    }
  } catch {
    // A body that refuses to be released is not a reason to fail a check-in.
  }
}

async function readResponse(
  response: PingHttpResponse,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
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
  } finally {
    await releaseBody(response)
  }

  return { status, body: typeof body === 'string' ? body : '', retryAfter }
}

async function attemptOnce(
  request: TransportRequest,
  send: FetchLike,
  budgetMs: number,
): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const controller = new AbortController()
  let expired = false
  let expire = (): void => {}
  const expiry = new Promise<never>((_resolve, reject) => {
    expire = () => {
      reject(new TransportFailure('timeout', 1, 'the check-in ran out of its time budget'))
    }
  })
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
    expire()
  }, budgetMs)
  unrefIfPossible(timer)

  const caller = isAbortSignalLike(request.signal) ? request.signal : undefined
  const relay = (): void => {
    controller.abort()
  }

  if (caller !== undefined) {
    if (caller.aborted) {
      controller.abort()
    } else {
      caller.addEventListener('abort', relay, { once: true })
    }
  }

  try {
    let response: PingHttpResponse
    let dispatched: Promise<PingHttpResponse> | undefined

    try {
      dispatched = send(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      })
      // The deadline is raced rather than trusted to the abort signal: a transport
      // that ignores the signal would otherwise hold the job open indefinitely.
      response = await Promise.race([dispatched, expiry])
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
        ? new TransportFailure('timeout', 1, 'the check-in ran out of its time budget', cause)
        : new TransportFailure('network-error', 1, 'the check-in could not reach the server', cause)
    }

    try {
      return await readResponse(response)
    } catch (cause) {
      throw cause instanceof TransportFailure
        ? cause
        : new TransportFailure('unexpected', 1, 'the transport response could not be read', cause)
    }
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', relay)
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
  const maxAttempts = Math.max(1, request.retries + 1)
  let attempt = 0
  let last: TransportFailure | undefined

  while (attempt < maxAttempts) {
    attempt += 1
    const budget = deadline - Date.now()

    if (budget <= 0) {
      throw new TransportFailure(
        'timeout',
        attempt - 1,
        'the check-in ran out of its time budget',
        last,
      )
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
          : new TransportFailure(
              'network-error',
              attempt,
              'the check-in could not reach the server',
              error,
            )

      if (failure.reason !== 'network-error' || attempt >= maxAttempts) {
        throw failure
      }

      last = failure
    }
  }

  throw (
    last ?? new TransportFailure('network-error', attempt, 'the check-in exhausted its attempts')
  )
}
