import { refuse } from './errors.js'
import type { CreateMonitorRequest } from '../api/types.js'

const KEY_PREFIX = 'sync-'

interface Digester {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
}

function subtle(): Digester {
  const crypto = (globalThis as { crypto?: { subtle?: Digester } }).crypto?.subtle

  if (crypto === undefined || typeof crypto.digest !== 'function') {
    refuse(
      'This runtime exposes no Web Crypto, so no key can be derived for a create. A create sent without one makes a second monitor every time it is repeated, so sync refuses rather than sending it unguarded.',
    )
  }

  return crypto
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Canonical, and derived from the request rather than from the configuration file: two runs
// of one configuration mint the same key, so a create the service already answered is
// replayed instead of making a second monitor — which is what a listing that skipped a row
// would otherwise cause. A changed request mints a different key, so a corrected monitor is
// not refused as a repeat of the one it replaces.
function canonical(request: CreateMonitorRequest): string {
  return JSON.stringify([
    request.name,
    request.scheduleKind,
    request.scheduleExpr,
    request.tz ?? null,
    request.graceSeconds ?? null,
    [...(request.channelIds ?? [])].map(String).sort((one, other) => Number(one) - Number(other)),
  ])
}

export async function idempotencyKeyFor(request: CreateMonitorRequest): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(canonical(request)))

  return `${KEY_PREFIX}${hex(digest)}`
}
