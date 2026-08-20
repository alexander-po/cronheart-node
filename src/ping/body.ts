import { PING_BODY_CAP_BYTES, PING_BODY_TRUNCATION_MARKER } from '../constants.js'

export type TruncateMode = 'head' | 'tail'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const PING_BODY_BUDGET_BYTES =
  PING_BODY_CAP_BYTES - encoder.encode(PING_BODY_TRUNCATION_MARKER).length

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

function sequenceLength(lead: number): number {
  if ((lead & 0x80) === 0) {
    return 1
  }

  if ((lead & 0xe0) === 0xc0) {
    return 2
  }

  if ((lead & 0xf0) === 0xe0) {
    return 3
  }

  return 4
}

function withoutTrailingPartial(bytes: Uint8Array): Uint8Array {
  let start = bytes.length - 1

  while (start >= 0 && isContinuation(bytes[start])) {
    start -= 1
  }

  const lead = start >= 0 ? bytes[start] : undefined

  if (lead === undefined) {
    return bytes
  }

  return start + sequenceLength(lead) > bytes.length ? bytes.subarray(0, start) : bytes
}

export function withoutLeadingPartial(bytes: Uint8Array): Uint8Array {
  let start = 0

  while (start < bytes.length && isContinuation(bytes[start])) {
    start += 1
  }

  return bytes.subarray(start)
}

export function truncateBody(body: string, mode: TruncateMode): string {
  const bytes = encoder.encode(body)

  if (bytes.length <= PING_BODY_CAP_BYTES) {
    return body
  }

  if (mode === 'tail') {
    const kept = withoutLeadingPartial(bytes.subarray(bytes.length - PING_BODY_BUDGET_BYTES))

    return PING_BODY_TRUNCATION_MARKER + decoder.decode(kept)
  }

  const kept = withoutTrailingPartial(bytes.subarray(0, PING_BODY_BUDGET_BYTES))

  return decoder.decode(kept) + PING_BODY_TRUNCATION_MARKER
}

const REDACTION = '[redacted]'

const BUILT_IN_SECRETS: readonly RegExp[] = [
  /cmk_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
]

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function inAnyCase(value: string): RegExp {
  return new RegExp(escapeLiteral(value), 'gi')
}

// Rebuilt rather than reused even when it is already global: a sticky pattern anchors
// every attempt at its own lastIndex, so it matches nothing beyond that position and
// redacts nothing at all, and a shared one carries that position between check-ins.
function globalised(pattern: string | RegExp): RegExp {
  if (typeof pattern === 'string') {
    return new RegExp(escapeLiteral(pattern), 'g')
  }

  return new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, '')}g`)
}

export function redactSecrets(text: string, patterns: readonly (string | RegExp)[]): string {
  return [...BUILT_IN_SECRETS, ...patterns].reduce<string>(
    (current, pattern) => current.replace(globalised(pattern), REDACTION),
    text,
  )
}
