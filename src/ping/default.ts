import { SDK_VERSION } from '../version.js'
import { defineMonitors } from '../wiring/validate.js'
import { createPingClient, createRefusingPingClient } from './client.js'
import type { MonitorRegistry, PingClient } from './types.js'

// The registry key is a well-known symbol on globalThis so that the ESM copy and the
// CommonJS copy of this package share one client: otherwise flush() on one would silently
// ignore the check-ins the other started. Symbol.for is shared across versions too, so the
// key carries the range a client is interchangeable within — the major once there is one,
// and the minor while there is not, because that is where 0.x ships a breaking change.
export function sharedClientKey(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(leadingNumber)

  if (major > 0) {
    return `cronheart.defaultClient/${major}`
  }

  return minor > 0 ? `cronheart.defaultClient/0.${minor}` : `cronheart.defaultClient/0.0.${patch}`
}

function leadingNumber(part: string): number {
  const parsed = Number.parseInt(part, 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const CLIENT_KEY = Symbol.for(sharedClientKey(SDK_VERSION))

const definitions: Record<string, string> = {}

export function defaultClient(): PingClient {
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[CLIENT_KEY]

  if (typeof (existing as PingClient | undefined)?.ping === 'function') {
    return existing as PingClient
  }

  const built = build()

  if (typeof built === 'string') {
    return createRefusingPingClient(built, definitions)
  }

  globals[CLIENT_KEY] = built

  return built
}

function build(): PingClient | string {
  try {
    return createPingClient({ monitors: definitions })
  } catch (error) {
    const stated = error instanceof Error ? error.message : String(error)

    return `${stated.replace(/^cronheart:\s*/, '')} Nothing checks in until that is fixed.`
  }
}

// A refusing client is deliberately not cached, so that a base URL corrected in the same
// process still builds a working one. What is defined against it is therefore held here
// rather than on it, or every definition would be discarded with the client that took it.
export const defaultMonitors: MonitorRegistry = {
  define: (next) => {
    defaultClient().monitors.define(next)
    defineMonitors(definitions, next)
  },
  resolve: (name) => defaultClient().monitors.resolve(name),
  has: (name) => defaultClient().monitors.has(name),
}
