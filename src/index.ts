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

export {
  PING_BODY_BUDGET_BYTES,
  PING_BODY_CAP_BYTES,
  PING_BODY_TRUNCATION_MARKER,
  PING_ROUTE_UUID_PATTERN,
  RUNTIME_HEADER_MAX_VALUE,
  RUNTIME_HEADER_NAME,
} from './constants.js'
export { createPingClient } from './ping/client.js'
export { CONTRACT_VERSION, SDK_VERSION, userAgent } from './version.js'
export {
  CronheartConfigurationError,
  InvalidActionError,
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

const CLIENT_KEY = Symbol.for('cronheart.defaultClient')

// The registry key is a well-known symbol on globalThis so that the ESM copy and
// the CommonJS copy of this package share one client: otherwise flush() on one
// would silently ignore the check-ins the other started.
function defaultClient(): PingClient {
  const host = globalThis as unknown as Record<symbol, unknown>
  const existing = host[CLIENT_KEY]

  if (existing !== null && typeof existing === 'object' && 'ping' in existing) {
    return existing as PingClient
  }

  const created = createPingClient()
  host[CLIENT_KEY] = created

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
