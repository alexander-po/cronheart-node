export const PING_OUTCOMES = [
  'accepted',
  'duplicate',
  'paused',
  'not-found',
  'rate-limited',
  'timeout',
  'network-error',
  'server-error',
  'unexpected',
  'suppressed',
  'disabled',
] as const

export type PingOutcome = (typeof PING_OUTCOMES)[number]

const DUPLICATE_BODY = 'OK (duplicate)'

const CONFIGURATION_OUTCOMES = new Set<PingOutcome>([
  'disabled',
  'suppressed',
  'not-found',
  'paused',
])

export function isConfigurationOutcome(outcome: PingOutcome): boolean {
  return CONFIGURATION_OUTCOMES.has(outcome)
}

export function classifyStatus(status: number, body: string): PingOutcome {
  if (status >= 200 && status < 300) {
    return body.trim() === DUPLICATE_BODY ? 'duplicate' : 'accepted'
  }

  if (status === 404) {
    return 'not-found'
  }

  if (status === 410) {
    return 'paused'
  }

  if (status === 429) {
    return 'rate-limited'
  }

  return status >= 500 ? 'server-error' : 'unexpected'
}

export function isAccepted(outcome: PingOutcome): boolean {
  return outcome === 'accepted' || outcome === 'duplicate'
}
