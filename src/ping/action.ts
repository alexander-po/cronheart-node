export type PingAction = 'heartbeat' | 'start' | 'success' | 'fail'

const SEGMENTS: Readonly<Record<PingAction, string | null>> = Object.freeze({
  heartbeat: null,
  start: 'start',
  success: 'success',
  fail: 'fail',
})

export function segmentFor(action: PingAction): string | null {
  return SEGMENTS[action]
}

export function isTerminal(action: PingAction): boolean {
  return action === 'success' || action === 'fail'
}
