export const PING_ACTIONS = ['heartbeat', 'start', 'success', 'fail'] as const

export const PING_EMITTABLE_ACTIONS = ['start', 'success', 'fail'] as const

export type PingAction = (typeof PING_ACTIONS)[number]

const EMITTABLE: ReadonlySet<string> = new Set(PING_EMITTABLE_ACTIONS)

export function isEmittableAction(action: string): boolean {
  return EMITTABLE.has(action)
}

// undefined rather than null for an unrecognised action: null is the heartbeat, and the
// server maps an unrecognised segment to a heartbeat too. The two must not collapse.
export function segmentFor(action: PingAction): string | null | undefined {
  if (action === 'heartbeat') {
    return null
  }

  return isEmittableAction(action) ? action : undefined
}

export function isTerminal(action: PingAction): boolean {
  return action === 'success' || action === 'fail'
}
