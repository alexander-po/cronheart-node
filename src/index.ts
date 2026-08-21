import { defaultClient } from './ping/default.js'
import type {
  CheckInThunk,
  CheckInWithOptions,
  MonitorRun,
  PingOptions,
  PingResult,
} from './ping/types.js'

export { PING_BODY_CAP_BYTES, PING_RESPONSE_BODY_CAP_BYTES } from './constants.js'
export { PING_ACTIONS, PING_EMITTABLE_ACTIONS } from './ping/action.js'
export { PING_OUTCOMES } from './ping/outcome.js'
export { createPingClient } from './ping/client.js'
export { defaultMonitors as monitors } from './ping/default.js'
export { describePingResult } from './ping/describe.js'
export { isMonitorId } from './ping/resolve.js'
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
  PingResponseBody,
  PingResponseBodyReader,
  PingResult,
} from './ping/types.js'

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
