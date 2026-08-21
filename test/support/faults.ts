import { PING_DUPLICATE_BODY } from '../../src/ping/outcome.js'
import type {
  FetchLike,
  PingClientOptions,
  PingHttpResponse,
  PingOptions,
  PingResponseBodyReader,
} from '../../src/ping/types.js'
import { createPingRecorder } from '../../src/testing.js'

export { API_KEY } from './api-recorder.js'

export const MONITOR_NAME = 'job'

export const MONITOR_ID = '00000000-0000-4000-8000-0000000000d4'

export const BASE_URL = 'https://faults.example'

export const BUDGET_MS = 60

export const RETRIES = 1

// A body that goes on arriving, fused so that a read which stopped honouring its cap
// cannot hang the matrix. Nothing here counts bytes: what the cap is worth is asserted
// against the check-in path, not here.
const ENDLESS_BODY_FUSE_BYTES = 1024 * 1024

export interface FaultInstance {
  readonly id: string
  readonly monitor: string
  readonly clientOptions: PingClientOptions
  readonly pingOptions: PingOptions
  undrainedBodies(): number
}

export interface Fault {
  readonly id: string
  create(): FaultInstance
}

function baseOptions(fetchImpl: FetchLike | undefined): PingClientOptions {
  return {
    baseUrl: BASE_URL,
    monitors: { [MONITOR_NAME]: MONITOR_ID },
    env: {},
    timeoutMs: BUDGET_MS,
    retries: RETRIES,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  }
}

// A body counts as released once the SDK has asked for it — read or cancelled.
// Waiting for the cancel to settle would blame the SDK for a stream that never
// finishes releasing, which no caller can do anything about.
function countingBodies(dispatch: FetchLike): {
  fetch: FetchLike
  undrainedBodies(): number
} {
  let open = 0

  const account = (response: PingHttpResponse): PingHttpResponse => {
    try {
      const stream = response.body

      if (stream === null || stream === undefined || typeof stream.cancel !== 'function') {
        return response
      }

      open += 1
      let released = false
      const release = (): void => {
        if (!released) {
          released = true
          open -= 1
        }
      }
      const cancel = stream.cancel.bind(stream)
      const read = typeof response.text === 'function' ? response.text.bind(response) : undefined
      const take = typeof stream.getReader === 'function' ? stream.getReader.bind(stream) : undefined

      ;(stream as { cancel: () => Promise<void> }).cancel = () => {
        release()

        return cancel()
      }

      if (take !== undefined) {
        ;(stream as { getReader: () => PingResponseBodyReader }).getReader = () => {
          const reader = take()
          const stop = reader.cancel.bind(reader)

          return {
            read: reader.read.bind(reader),
            cancel: () => {
              release()

              return stop()
            },
          }
        }
      }

      if (read !== undefined) {
        ;(response as { text?: () => Promise<string> }).text = () => {
          release()

          return read()
        }
      }

      return response
    } catch {
      return response
    }
  }

  return {
    fetch: (url, init) => dispatch(url, init).then(account),
    undrainedBodies: () => open,
  }
}

export function fault(
  id: string,
  build: () => {
    fetch?: FetchLike
    clientOptions?: Partial<PingClientOptions>
    pingOptions?: PingOptions
    monitor?: string
    undrainedBodies?: () => number
  },
): Fault {
  return {
    id,
    create: () => {
      const built = build()
      // Every case gets a stub transport even when the fault is not about the
      // transport: a missing one would fall through to the runtime's own fetch and
      // put the suite on the network.
      const fallback = built.fetch === undefined ? createPingRecorder() : undefined
      const counted =
        built.fetch !== undefined && built.undrainedBodies === undefined
          ? countingBodies(built.fetch)
          : undefined
      const dispatch = counted?.fetch ?? built.fetch ?? fallback?.fetch

      return {
        id,
        monitor: built.monitor ?? MONITOR_NAME,
        clientOptions: { ...baseOptions(dispatch), ...built.clientOptions },
        pingOptions: built.pingOptions ?? {},
        undrainedBodies:
          built.undrainedBodies ??
          (() => counted?.undrainedBodies() ?? fallback?.undrainedBodies ?? 0),
      }
    },
  }
}

function recorded(
  id: string,
  stub: Parameters<ReturnType<typeof createPingRecorder>['respondWith']>[0],
) {
  return fault(id, () => {
    const recorder = createPingRecorder(stub)

    return { fetch: recorder.fetch, undrainedBodies: () => recorder.undrainedBodies }
  })
}

export const FAULTS: readonly Fault[] = [
  recorded('transport-accepts', {}),
  recorded('transport-reports-a-duplicate', { body: PING_DUPLICATE_BODY }),
  recorded('transport-returns-a-server-error', { status: 500, body: 'boom' }),
  recorded('transport-returns-not-found', { status: 404, body: 'Monitor not found' }),
  recorded('transport-reports-the-monitor-paused', { status: 410, body: 'Monitor paused' }),
  recorded('transport-rate-limits', {
    status: 429,
    body: 'Rate limited',
    headers: { 'retry-after': '30' },
  }),
  recorded('transport-never-settles', { hang: true }),
  recorded('transport-rejects', { rejectWith: new Error('socket hang up') }),
  recorded('transport-rejects-a-non-error', { rejectWith: 'a bare string' }),
  recorded('transport-rejects-null', { rejectWith: null }),
  fault('transport-throws-synchronously', () => ({
    fetch: () => {
      throw new TypeError('fetch exploded before it returned a promise')
    },
  })),
  fault('transport-resolves-a-non-response', () => ({
    fetch: () =>
      Promise.resolve({
        get status(): number {
          throw new Error('status exploded')
        },
        bodyUsed: false,
        body: { cancel: () => Promise.resolve() },
      } as unknown as PingHttpResponse),
  })),
  fault('transport-resolves-a-bare-object', () => ({
    fetch: () => Promise.resolve({} as unknown as PingHttpResponse),
  })),
  fault('transport-answers-with-a-body-that-never-ends', () => ({
    fetch: () => {
      const chunk = new TextEncoder().encode('x'.repeat(1024))
      let pulled = 0

      return Promise.resolve<PingHttpResponse>({
        status: 200,
        headers: { get: () => null },
        // Disturbed by the first read, the way a real response is: past that point the
        // reader is the only thing that can release it.
        get bodyUsed() {
          return pulled > 0
        },
        body: {
          cancel: () => Promise.resolve(),
          getReader: () => ({
            read: () => {
              pulled += chunk.length

              return Promise.resolve(
                pulled > ENDLESS_BODY_FUSE_BYTES ? { done: true } : { done: false, value: chunk },
              )
            },
            cancel: () => Promise.resolve(),
          }),
        },
      })
    },
  })),
  recorded('transport-body-refuses-to-be-read', {
    readRejectsWith: new Error('the body cannot be read'),
  }),
  fault('the-monitor-name-resolves-to-nothing', () => ({ monitor: 'a-name-nothing-defines' })),
  fault('the-configured-id-is-not-an-id', () => ({
    monitor: 'from-the-environment',
    clientOptions: { env: { CRONHEART_FROM_THE_ENVIRONMENT_UUID: 'not-an-id' } },
  })),
  fault('the-monitor-is-addressed-by-its-raw-id', () => {
    const recorder = createPingRecorder({ status: 404, body: 'Monitor not found' })

    return {
      fetch: recorder.fetch,
      monitor: MONITOR_ID,
      undrainedBodies: () => recorder.undrainedBodies,
    }
  }),
  fault('the-kill-switch-is-on', () => ({ clientOptions: { disabled: true } })),
  fault('the-base-url-carries-a-path', () => ({
    clientOptions: { baseUrl: `${BASE_URL}/behind/a/proxy/` },
    fetch: (url: string) => {
      new URL(url)

      return Promise.resolve({ status: 200, text: () => Promise.resolve('OK') })
    },
  })),
  fault('the-result-sink-throws', () => ({
    clientOptions: {
      onResult: () => {
        throw new Error('the observer exploded')
      },
    },
  })),
  fault('the-body-cannot-be-stringified', () => ({
    pingOptions: {
      body: {
        toString: () => {
          throw new Error('toString exploded')
        },
      } as unknown as string,
    },
  })),
  fault('the-caller-signal-is-not-a-signal', () => ({
    clientOptions: { signal: 'definitely not a signal' as unknown as undefined },
  })),
  fault('the-caller-signal-is-already-aborted', () => ({
    clientOptions: { signal: AbortSignal.abort() },
  })),
]
