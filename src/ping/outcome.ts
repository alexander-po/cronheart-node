export const PING_OUTCOMES = [
  'accepted',
  'duplicate',
  'paused',
  'not-found',
  'rate-limited',
  'timeout',
  'aborted',
  'network-error',
  'server-error',
  'unexpected',
  'suppressed',
  'disabled',
] as const

export type PingOutcome = (typeof PING_OUTCOMES)[number]

// The server separates an accepted check-in from a duplicate one by this response body
// alone: same status, no distinguishing header. A wording change on the far side turns
// every duplicate into an accepted check-in, so the literal is anchored in the contract.
export const PING_DUPLICATE_BODY = 'OK (duplicate)'

export const PING_STATUS_OUTCOMES = {
  '2xx': 'accepted',
  '404': 'not-found',
  '410': 'paused',
  '429': 'rate-limited',
  '5xx': 'server-error',
  other: 'unexpected',
} as const satisfies Readonly<Record<string, PingOutcome>>

type StatusKey = keyof typeof PING_STATUS_OUTCOMES

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
    return body.trim() === PING_DUPLICATE_BODY ? 'duplicate' : PING_STATUS_OUTCOMES['2xx']
  }

  const exact = String(status)

  if (Object.hasOwn(PING_STATUS_OUTCOMES, exact)) {
    return PING_STATUS_OUTCOMES[exact as StatusKey]
  }

  return status >= 500 ? PING_STATUS_OUTCOMES['5xx'] : PING_STATUS_OUTCOMES.other
}

export function isAccepted(outcome: PingOutcome): boolean {
  return outcome === 'accepted' || outcome === 'duplicate'
}
