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

const READS_BETWEEN_TURNS = 1024

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

    if (response.bodyUsed === true || stream === null || stream === undefined) {
      return
    }

    if (typeof stream.cancel === 'function') {
      await releaseWithin(() => stream.cancel())

      return
    }

    const destroy = (stream as { destroy?: () => void }).destroy

    if (typeof destroy === 'function') {
      destroy.call(stream)
    }
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

// A Node stream, which is what node-fetch hands back, offers no reader but can be walked a
// piece at a time, and so read under the cap like one.
function piecesOf(stream: object): PingResponseBodyReader | undefined {
  const walk = (stream as { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> })[
    Symbol.asyncIterator
  ]

  if (typeof walk !== 'function') {
    return undefined
  }

  const pieces = walk.call(stream)
  const destroy = (stream as { destroy?: () => void }).destroy

  return {
    read: () => pieces.next(),
    cancel: async () => {
      if (typeof destroy === 'function') {
        destroy.call(stream)
      }

      await pieces.return?.()
    },
  }
}

// A stream that will not hand over a usable reader is refused, not read whole: a real
// response in that state refuses text() too, so only an uncapped read could answer instead.
function readerFor(response: PingHttpResponse): PingResponseBodyReader | undefined {
  const stream = response.body

  if (response.bodyUsed === true || stream === null || stream === undefined) {
    return undefined
  }

  if (typeof stream.getReader !== 'function') {
    return piecesOf(stream)
  }

  const reader = stream.getReader()

  if (typeof reader?.read !== 'function') {
    throw new TypeError('the response body offered a reader it cannot be read with')
  }

  return reader
}

// No UTF-16 unit takes more than three bytes, so a body that short is under the cap as it is.
function keptOf(body: string, capBytes: number): string {
  if (body.length * 3 <= capBytes) {
    return body
  }

  const { read } = new TextEncoder().encodeInto(body, new Uint8Array(capBytes))

  return body.slice(0, read)
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
  let reads = 0

  while (remaining > 0 && !abandoned.aborted) {
    const chunk = await reader.read()

    if (chunk.done === true || !ArrayBuffer.isView(chunk.value)) {
      return text
    }

    // Bytes rather than elements: every view is admitted, and the cap is a size in bytes,
    // which for anything wider than a byte array is not the number of them it holds.
    const arrived = chunk.value
    const kept =
      arrived.byteLength <= remaining
        ? arrived
        : new Uint8Array(arrived.buffer, arrived.byteOffset, remaining)
    remaining -= kept.byteLength
    text += decoder.decode(kept, { stream: true })
    reads += 1

    // Settled reads run in microtasks, where the deadline's timer never gets a turn: every so
    // many pieces hand it one. A turn per piece would stall a suite on fake timers.
    if (remaining > 0 && reads % READS_BETWEEN_TURNS === 0) {
      await countdown(0).reached
    }
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

    return typeof body === 'string' ? keptOf(body, capBytes) : ''
  } catch {
    return ''
  } finally {
    await releaseBody(response)
  }
}

function relayAbort(signal: unknown, relay: () => void): AbortSignalLike | undefined {
  try {
    if (!isAbortSignalLike(signal)) {
      return undefined
    }

    if (signal.aborted) {
      relay()

      return undefined
    }

    signal.addEventListener('abort', relay, { once: true })

    return signal
  } catch {
    // A hand-built signal is an input like any other: ignoring one that throws costs
    // the caller their cancellation, while trusting it would cost the check-in.
    return undefined
  }
}

function wasStopped(signal: unknown): boolean {
  try {
    return isAbortSignalLike(signal) && signal.aborted === true
  } catch {
    return false
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
  const gaveUp = (): TransportFailure =>
    stoppedBy === 'caller'
      ? new TransportFailure('aborted', CANCELLED, undefined, 1)
      : new TransportFailure('timeout', OUT_OF_BUDGET, undefined, 1)
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

      // What the host's transport rejected with stays behind: one that names the request it
      // failed on names the monitor id with it, and the id is the whole credential.
      throw expired || controller.signal.aborted
        ? gaveUp()
        : new TransportFailure('network-error', UNREACHABLE, undefined, 1)
    }

    try {
      // The same deadline covers the read, because a transport that ignores the signal
      // ignores it while handing the body over too.
      const answer = headOf(response)
      const read = await Promise.race([
        readBody(response, request.bodyCapBytes, controller.signal),
        reached,
      ])

      // A cancellation the caller asked for is not an answer, whether the read came back or
      // the deadline landed on it first: what would be reported is a body they stopped, and
      // a fragment of a duplicate reads as an accepted check-in.
      if (stoppedBy === 'caller') {
        throw gaveUp()
      }

      if (read !== EXPIRED) {
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
        : new TransportFailure('unexpected', 'the transport response could not be read', undefined, 1)
    } finally {
      void releaseBody(response)
    }
  } finally {
    deadline.cancel()
    stopRelaying(listening, relay)
    // A transport that holds the request until its body ends, as node-fetch does, lets a body
    // cut short at the cap go only when the signal says so.
    controller.abort()
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
      // A cancellation landing between attempts is seen by nobody else: no attempt is in
      // flight to relay it, and the answer being held is one the caller stopped waiting for.
      const cancelled = wasStopped(request.signal)

      // A server that answered and then ran the budget out is a different report from a
      // server that was never reached, and the retried answer is the more informative one.
      if (answered !== undefined && !cancelled) {
        return { ...answered, attempts: attempt - 1 }
      }

      throw cancelled
        ? new TransportFailure('aborted', CANCELLED, last, attempt - 1)
        : new TransportFailure('timeout', OUT_OF_BUDGET, last, attempt - 1)
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
          : new TransportFailure('network-error', UNREACHABLE, undefined, attempt)

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
