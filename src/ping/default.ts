import { SDK_VERSION } from '../version.js'
import { createPingClient } from './client.js'
import type { PingClient } from './types.js'

// The registry key is a well-known symbol on globalThis so that the ESM copy and the
// CommonJS copy of this package share one client: otherwise flush() on one would silently
// ignore the check-ins the other started. Symbol.for is shared across versions too, so the
// major rides in the key — a v1 call site must not adopt a v2 client and return its shape.
const CLIENT_KEY = Symbol.for(`cronheart.defaultClient/${Number.parseInt(SDK_VERSION, 10)}`)

export function defaultClient(): PingClient {
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[CLIENT_KEY]

  if (typeof (existing as PingClient | undefined)?.ping === 'function') {
    return existing as PingClient
  }

  const created = createPingClient()
  globals[CLIENT_KEY] = created

  return created
}
