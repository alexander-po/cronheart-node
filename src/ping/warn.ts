const STORE_KEY = Symbol.for('cronheart.warnedOutcomes')

function warned(): Set<string> {
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[STORE_KEY]

  if (existing instanceof Set) {
    return existing as Set<string>
  }

  const created = new Set<string>()
  globals[STORE_KEY] = created

  return created
}

// Keyed by monitor as well as subject: one warning per process for a whole fleet of
// misconfigured monitors would name the first and leave the rest silent forever.
export function warnOnce(subject: string, monitor: string, message: string): void {
  const seen = warned()
  const key = `${subject}\u0000${monitor}`

  if (seen.has(key)) {
    return
  }

  seen.add(key)

  const sink = (globalThis as { console?: { warn?: (message: string) => void } }).console

  if (typeof sink?.warn !== 'function') {
    return
  }

  try {
    sink.warn(message)
  } catch {}
}

export function clearWarnings(): void {
  warned().clear()
}
