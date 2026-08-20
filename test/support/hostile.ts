import type {
  AbortSignalLike,
  FetchLike,
  PingHttpResponse,
  PingOptions,
} from '../../src/ping/types.js'
import type { Host } from './fault-harness.js'
import { type Fault, fault } from './faults.js'

function exploding(what: string): () => never {
  return () => {
    throw new TypeError(`the ${what} exploded`)
  }
}

function optionsThatExplodeOnRead(members: readonly (keyof PingOptions)[]): PingOptions {
  const options: Record<string, unknown> = {}

  for (const member of members) {
    Object.defineProperty(options, member, {
      enumerable: true,
      get: exploding(`${member} the caller passed in`),
    })
  }

  return options as PingOptions
}

function signalThatExplodes(member: 'aborted' | 'addEventListener'): AbortSignalLike {
  return {
    get aborted(): boolean {
      if (member === 'aborted') {
        exploding('caller signal')()
      }

      return false
    },
    addEventListener: () => {
      if (member === 'addEventListener') {
        exploding('caller signal')()
      }
    },
    removeEventListener: () => {},
  }
}

function respondingWith(response: () => PingHttpResponse): FetchLike {
  return () => Promise.resolve(response())
}

const stalledBody: FetchLike = respondingWith(() => ({
  status: 200,
  headers: { get: () => null },
  bodyUsed: false,
  body: { cancel: () => Promise.resolve() },
  text: () => new Promise<string>(() => {}),
}))

const bodyThatNeverFinishesReleasing: FetchLike = respondingWith(() => ({
  status: 200,
  headers: { get: () => null },
  bodyUsed: false,
  body: { cancel: () => new Promise<void>(() => {}) },
  text: () => Promise.resolve('OK'),
}))

// The transport and configuration axes vary what the service and the deployment do.
// This one varies what the host hands in, which is the half a consumer controls and
// the half nothing else in the matrix touches.
export const HOSTILE_INPUTS: readonly Fault[] = [
  fault('the-options-object-explodes-on-the-body', () => ({
    pingOptions: optionsThatExplodeOnRead(['body', 'runtimeMs']),
  })),
  fault('the-options-object-explodes-on-the-transport-knobs', () => ({
    pingOptions: optionsThatExplodeOnRead(['timeoutMs', 'retries', 'truncate', 'signal']),
  })),
  fault('the-result-sink-rejects-asynchronously', () => ({
    clientOptions: {
      onResult: async () => {
        await Promise.resolve()

        throw new Error('the observer exploded later')
      },
    },
  })),
  fault('the-caller-signal-explodes-when-read', () => ({
    clientOptions: { signal: signalThatExplodes('aborted') },
  })),
  fault('the-caller-signal-explodes-when-listened-to', () => ({
    clientOptions: { signal: signalThatExplodes('addEventListener') },
  })),
  fault('the-response-body-never-arrives', () => ({ fetch: stalledBody })),
  fault('the-response-body-never-finishes-releasing', () => ({
    fetch: bodyThatNeverFinishesReleasing,
  })),
]

function hostWhoseErrorExplodes(accessor: 'stack' | 'message'): Host {
  const failure = new Error('the job itself failed')

  Object.defineProperty(failure, accessor, {
    configurable: true,
    get: exploding(`host error's ${accessor}`),
  })

  return {
    id: `throws-an-error-whose-${accessor}-explodes`,
    throws: true,
    expected: failure,
    call: () => {
      throw failure
    },
  }
}

export function hostileHosts(): Host[] {
  return [hostWhoseErrorExplodes('stack'), hostWhoseErrorExplodes('message')]
}
