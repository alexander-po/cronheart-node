import { createPingClient } from '../../src/ping/client.js'
import { clearWarnings } from '../../src/testing.js'
import { BUDGET_MS, type Fault } from './faults.js'
import type { EntryPoint } from './entry-points.js'
import { captureUnhandledRejections } from './unhandled.js'

const OVERHEAD_ALLOWANCE_MS = 300

const HARD_CAP_ALLOWANCE_MS = 500

export const INVARIANTS = [
  'no-exception-crosses-the-boundary',
  'the-host-value-comes-back',
  'the-host-error-arrives-unchanged',
  'overhead-stays-bounded',
  'no-unhandled-rejection',
  'no-identifier-in-the-output',
  'no-response-body-left-open',
] as const

export type Invariant = (typeof INVARIANTS)[number]

export interface Host {
  readonly id: string
  readonly throws: boolean
  readonly expected: unknown
  call(): unknown
}

export function hosts(): Host[] {
  const returned = { rows: 7 }
  const resolved = { rows: 9 }
  const failure = new Error('the job itself failed')

  return [
    { id: 'returns-a-value', throws: false, expected: returned, call: () => returned },
    {
      id: 'returns-a-thenable',
      throws: false,
      expected: resolved,
      call: () => ({
        then: (resolve: (value: unknown) => void) => {
          resolve(resolved)
        },
      }),
    },
    {
      id: 'throws',
      throws: true,
      expected: failure,
      call: () => {
        throw failure
      },
    },
  ]
}

export interface Observation {
  readonly returned: unknown
  readonly thrown: unknown
  readonly threw: boolean
  readonly settled: boolean
  readonly elapsedMs: number
  readonly boundMs: number
  readonly unhandled: readonly unknown[]
  readonly output: string
  readonly undrainedBodies: number
  readonly stack: string | undefined
}

type Writer = (chunk: string | Uint8Array) => boolean

function captureOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const sink = console as unknown as Record<string, unknown>
  const previous = new Map<string, unknown>()

  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    previous.set(method, sink[method])
    sink[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '))
    }
  }

  const stdout = process.stdout.write.bind(process.stdout) as Writer
  const stderr = process.stderr.write.bind(process.stderr) as Writer
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))

    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))

    return true
  }) as typeof process.stderr.write

  return {
    lines,
    restore: () => {
      for (const [method, original] of previous) {
        sink[method] = original
      }

      process.stdout.write = stdout as typeof process.stdout.write
      process.stderr.write = stderr as typeof process.stderr.write
    },
  }
}

function delay(ms: number): { reached: Promise<'capped'>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined
  const reached = new Promise<'capped'>((resolve) => {
    handle = setTimeout(() => resolve('capped'), ms)
    handle.unref?.()
  })

  return {
    reached,
    cancel: () => {
      if (handle !== undefined) {
        clearTimeout(handle)
      }
    },
  }
}

export async function observe(
  entryPoint: EntryPoint,
  fault: Fault,
  host: Host,
): Promise<Observation> {
  const instance = fault.create()
  const client = createPingClient(instance.clientOptions)
  // The timeout is one budget across attempts, so a bound that multiplied by the
  // retry count would sit wide enough to hide a regression back to a per-attempt one.
  const boundMs = entryPoint.pings * BUDGET_MS + OVERHEAD_ALLOWANCE_MS
  const cap = delay(boundMs + HARD_CAP_ALLOWANCE_MS)
  const capture = captureOutput()
  clearWarnings()
  const startedAt = Date.now()

  const { value: settlement, unhandled } = await captureUnhandledRejections(async () => {
    const attempt = entryPoint
      .invoke({ client, fault: instance, host: host.call })
      .then((returned) => ({ kind: 'returned' as const, returned }))
      .catch((thrown: unknown) => ({ kind: 'threw' as const, thrown }))

    return Promise.race([attempt, cap.reached])
  })

  const elapsedMs = Date.now() - startedAt
  cap.cancel()
  capture.restore()

  const settled = settlement !== 'capped'
  const threw = settled && settlement.kind === 'threw'
  const thrown = threw ? (settlement as { thrown: unknown }).thrown : undefined

  return {
    returned: settled && settlement.kind === 'returned' ? settlement.returned : undefined,
    thrown,
    threw,
    settled,
    elapsedMs,
    boundMs,
    unhandled,
    output: capture.lines.join('\n'),
    undrainedBodies: instance.undrainedBodies(),
    stack: stackOf(thrown),
  }
}

function stackOf(value: unknown): string | undefined {
  try {
    return value instanceof Error ? value.stack : undefined
  } catch {
    return undefined
  }
}

function describeQuietly(value: unknown): string {
  const parts: string[] = []

  for (const read of [
    () => String(value),
    () => (value instanceof Error ? value.message : ''),
    () => stackOf(value) ?? '',
  ]) {
    try {
      parts.push(read())
    } catch {
      parts.push('')
    }
  }

  return parts.join('\n')
}

// Case-folded, and with the underscore of a screamed environment-variable name
// folded back to a hyphen: an id that reaches a log line mangled has still reached it.
function mentions(text: string, monitorId: string): boolean {
  return text.toLowerCase().replaceAll('_', '-').includes(monitorId.toLowerCase())
}

function sdkAuthoredText(observation: Observation, host: Host): string {
  const written = [observation.output]

  if (observation.threw && observation.thrown !== host.expected) {
    written.push(describeQuietly(observation.thrown))
  }

  return written.join('\n')
}

const TOKEN_SHAPED = /cmk_[A-Za-z0-9]/

export function violations(
  observation: Observation,
  host: Host,
  monitorId: string,
): Invariant[] {
  const found: Invariant[] = []

  if (!observation.settled || observation.elapsedMs > observation.boundMs) {
    found.push('overhead-stays-bounded')
  }

  if (observation.settled) {
    if (host.throws) {
      const sameError = observation.threw && observation.thrown === host.expected
      const sameStack = observation.stack === stackOf(host.expected)

      if (!sameError || !sameStack) {
        found.push('the-host-error-arrives-unchanged')
      }
    } else if (observation.threw) {
      found.push('no-exception-crosses-the-boundary')
    } else if (observation.returned !== host.expected) {
      found.push('the-host-value-comes-back')
    }
  }

  if (observation.unhandled.length > 0) {
    found.push('no-unhandled-rejection')
  }

  const written = sdkAuthoredText(observation, host)

  if (mentions(written, monitorId) || TOKEN_SHAPED.test(written)) {
    found.push('no-identifier-in-the-output')
  }

  if (observation.undrainedBodies > 0) {
    found.push('no-response-body-left-open')
  }

  return found
}
