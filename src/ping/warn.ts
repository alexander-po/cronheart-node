import type { PingOutcome } from './types.js'

const STORE_KEY = Symbol.for('cronheart.warnedOutcomes')

function warned(): Set<string> {
  const host = globalThis as unknown as Record<symbol, unknown>
  const existing = host[STORE_KEY]

  if (existing instanceof Set) {
    return existing as Set<string>
  }

  const created = new Set<string>()
  host[STORE_KEY] = created

  return created
}

export function warnOnce(outcome: PingOutcome, message: string): void {
  const seen = warned()

  if (seen.has(outcome)) {
    return
  }

  seen.add(outcome)

  const sink = (globalThis as { console?: { warn?: (message: string) => void } }).console

  if (typeof sink?.warn !== 'function') {
    return
  }

  try {
    sink.warn(message)
  } catch {
    // A host that has replaced console must not be able to change a check-in's outcome.
  }
}

export function clearWarnings(): void {
  warned().clear()
}
