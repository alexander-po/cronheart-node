import { createPingClient } from './ping/client.js'
import type {
  CheckInThunk,
  CheckInWithOptions,
  MonitorRegistry,
  MonitorRun,
  PingClient,
  PingOptions,
  PingResult,
} from './ping/types.js'
import { SDK_VERSION } from './version.js'

export { PING_BODY_CAP_BYTES } from './constants.js'
export { PING_ACTIONS } from './ping/action.js'
export { PING_OUTCOMES } from './ping/outcome.js'
export { createPingClient } from './ping/client.js'
export { CONTRACT_VERSION, SDK_VERSION, userAgent } from './version.js'
export {
  CronheartConfigurationError,
  InvalidActionError,
  InvalidBaseUrlError,
  InvalidMonitorIdError,
  UnknownMonitorError,
} from './wiring/errors.js'
export type { PingAction } from './ping/action.js'
export type { TruncateMode } from './ping/body.js'
export type {
  AbortSignalLike,
  CheckInThunk,
  CheckInWithOptions,
  FetchLike,
  MonitorRegistry,
  MonitorRun,
  PingClient,
  PingClientOptions,
  PingHttpResponse,
  PingOptions,
  PingOutcome,
  PingRequestInit,
  PingResult,
} from './ping/types.js'

// The registry key is a well-known symbol on globalThis so that the ESM copy and the
// CommonJS copy of this package share one client: otherwise flush() on one would silently
// ignore the check-ins the other started. Symbol.for is shared across versions too, so the
// major rides in the key — a v1 call site must not adopt a v2 client and return its shape.
const CLIENT_KEY = Symbol.for(`cronheart.defaultClient/${Number.parseInt(SDK_VERSION, 10)}`)

function defaultClient(): PingClient {
  const globals = globalThis as unknown as Record<symbol, unknown>
  const existing = globals[CLIENT_KEY]

  if (typeof (existing as PingClient | undefined)?.ping === 'function') {
    return existing as PingClient
  }

  const created = createPingClient()
  globals[CLIENT_KEY] = created

  return created
}

export function checkIn(name: string, options?: PingOptions): Promise<PingResult> {
  return defaultClient().ping(name, options)
}

export function withMonitor<T>(
  name: string,
  run: () => T | PromiseLike<T>,
  options?: PingOptions,
): Promise<Awaited<T>> {
  return defaultClient().withMonitor(name, run, options)
}

export function startRun(name: string, options?: PingOptions): MonitorRun {
  return defaultClient().startRun(name, options)
}

export function checkInWith(name: string, options?: CheckInWithOptions): CheckInThunk {
  return defaultClient().checkInWith(name, options)
}

export function flush(timeoutMs?: number): Promise<void> {
  return defaultClient().flush(timeoutMs)
}

export const monitors: MonitorRegistry = {
  define: (next) => defaultClient().monitors.define(next),
  resolve: (name) => defaultClient().monitors.resolve(name),
  has: (name) => defaultClient().monitors.has(name),
}
