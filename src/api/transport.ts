import { TransportFailure, ambientFetch, send } from '../transport/send.js'
import type { AbortSignalLike, FetchLike } from '../ping/types.js'
import { ApiConfigurationError, ApiTransportError, type ApiTransportReason } from './errors.js'

export interface WireRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
  readonly timeoutMs: number
  readonly signal: AbortSignalLike | undefined
  readonly fetch: FetchLike | undefined
}

export interface WireResponse {
  readonly status: number
  readonly body: string
  header(name: string): string | null
}

const REASONS: Readonly<Record<string, { reason: ApiTransportReason; message: string }>> = {
  timeout: { reason: 'timeout', message: 'The request ran out of its time budget.' },
  aborted: { reason: 'aborted', message: 'The caller aborted the request.' },
  'network-error': { reason: 'network-error', message: 'The request never reached the service.' },
  unexpected: {
    reason: 'unexpected',
    message: 'The transport did not produce a usable HTTP response.',
  },
}

// No cause is attached, here or anywhere else in this client. The underlying rejection is
// the one object in the chain the host's own transport authored, and a transport that
// describes the request it failed on describes the headers too — which is where the key is.
export function transportErrorFor(error: unknown): ApiTransportError {
  const reason = error instanceof TransportFailure ? error.reason : 'network-error'
  const known = REASONS[reason] ?? REASONS['network-error']

  return new ApiTransportError(
    known?.reason ?? 'network-error',
    known?.message ?? 'The request never reached the service.',
  )
}

export async function exchange(request: WireRequest): Promise<WireResponse> {
  const transport = request.fetch ?? ambientFetch()

  if (transport === undefined) {
    throw new ApiConfigurationError(
      'cronheart: this runtime has no fetch — pass one to createCronheartApi',
    )
  }

  let seen: { get(name: string): string | null } | null | undefined

  // The response headers are read off the way past rather than by widening the check-in
  // transport, which is inlined into the ping entry and has a size budget to keep.
  const observing: FetchLike = (url, init) =>
    Promise.resolve(transport(url, init)).then((response) => {
      try {
        seen = response.headers
      } catch {
        seen = undefined
      }

      return response
    })

  let answered

  try {
    answered = await send({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
      timeoutMs: request.timeoutMs,
      retries: 0,
      signal: request.signal,
      fetch: observing,
    })
  } catch (error) {
    throw transportErrorFor(error)
  }

  return {
    status: answered.status,
    body: answered.body,
    header: (name) => {
      try {
        return seen?.get(name) ?? null
      } catch {
        return null
      }
    },
  }
}
