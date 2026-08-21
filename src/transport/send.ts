import { BODY_RELEASE_BUDGET_MS, RETRY_FLOOR_DELAY_MS } from '../constants.js'
import type {
  AbortSignalLike,
  FetchLike,
  PingHttpResponse,
  PingResponseBodyReader,
} from '../ping/types.js'
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
  // What the caller is prepared to hold of an answer. A check-in reads a token; the
  // management client reads a page, and one cap for both would truncate the page. It has
  // to exceed the longest reply that must be told apart from another one.
  readonly bodyCapBytes: number
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

function isServerError(status: number): boolean {
  return status >= 500
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

async function releaseWithin(cancel: () => Promise<void>): Promise<void> {
  let gaveUp: Countdown | undefined

  try {
    // A stream that never finishes releasing must not hold the check-in.
    gaveUp = detachedCountdown(BODY_RELEASE_BUDGET_MS)

    await Promise.race([cancel(), gaveUp.reached])
  } catch {
  } finally {
    gaveUp?.cancel()
  }
}

async function releaseBody(response: PingHttpResponse): Promise<void> {
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

    await releaseWithin(() => stream.cancel())
  } catch {}
}

function headOf(response: PingHttpResponse): Omit<ReadResponse, 'body'> {
  const status = response.status

  if (typeof status !== 'number' || !Number.isFinite(status)) {
    throw new TransportFailure(
      'unexpected',
      'the transport resolved to something that is not an HTTP response',
    )
  }

  const headers = response.headers

  return {
    status,
    retryAfter: typeof headers?.get === 'function' ? headers.get('retry-after') : null,
  }
}

function readerFor(response: PingHttpResponse): PingResponseBodyReader | undefined {
  const stream = response.body

  if (
    response.bodyUsed === true ||
    stream === null ||
    stream === undefined ||
    typeof stream.getReader !== 'function'
  ) {
    return undefined
  }

  const reader = stream.getReader()

  return typeof reader?.read === 'function' ? reader : undefined
}

// The runtime decompresses whatever arrives before this sees it, so a reply read whole
// hands anything that can answer for a monitor the host's heap.
async function readCapped(
  reader: PingResponseBodyReader,
  capBytes: number,
  abandoned: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder()
  let remaining = capBytes
  let text = ''

  while (remaining > 0 && !abandoned.aborted) {
    const chunk = await reader.read()

    if (chunk.done === true || !ArrayBuffer.isView(chunk.value)) {
      return text
    }

    if (chunk.value.length === 0) {
      // A chunk carrying nothing is not the end of a body, and it is not progress either:
      // without a turn for the event loop the deadline's own timer would never run, and
      // a stream that only ever yields nothing would hold this loop for good.
      await countdown(0).reached

      continue
    }

    const kept = chunk.value.length <= remaining ? chunk.value : chunk.value.subarray(0, remaining)
    remaining -= kept.length
    text += decoder.decode(kept, { stream: true })
  }

  return text
}

async function readBody(
  response: PingHttpResponse,
  capBytes: number,
  abandoned: AbortSignal,
): Promise<string> {
  try {
    const reader = readerFor(response)

    if (reader !== undefined) {
      // A transport that ignores the signal never settles the read, so the release below
      // never runs. The signal is then the only thing left that can let the body go.
      abandoned.addEventListener('abort', () => void releaseWithin(() => reader.cancel()), {
        once: true,
      })

      try {
        return await readCapped(reader, capBytes, abandoned)
      } finally {
        // Not awaited: the answer is already in hand, and a cancel the far side lets stall
        // would spend the caller's remaining budget on a body nobody is waiting for.
        void releaseWithin(() => reader.cancel())
      }
    }

    const body = typeof response.text === 'function' ? await response.text() : ''

    return typeof body === 'string' ? body : ''
  } catch {
    return ''
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
      // The same deadline covers the read, because a transport that ignores the signal
      // ignores it while handing the body over too.
      const answer = headOf(response)
      const read = await Promise.race([
        readBody(response, request.bodyCapBytes, controller.signal),
        reached,
      ])

      if (read !== EXPIRED) {
        // A read the caller's own cancellation ended is not an answer: what came back is
        // whatever had arrived, and a fragment of a duplicate reads as an accepted check-in.
        if (stoppedBy === 'caller') {
          throw gaveUp()
        }

        return { ...answer, body: read }
      }

      // The answer send() would carry into another attempt is the answer this attempt
      // keeps: reaching the deadline over its body does not un-answer a server error.
      if (isServerError(answer.status)) {
        return { ...answer, body: '' }
      }

      throw gaveUp()
    } catch (cause) {
      throw cause instanceof TransportFailure
        ? cause
        : new TransportFailure('unexpected', 'the transport response could not be read', cause, 1)
    } finally {
      void releaseBody(response)
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

      if (isServerError(outcome.status) && attempt < request.attempts) {
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
