import type { PingAction } from './action.js'
import type { TruncateMode } from './body.js'
import type { PingOutcome } from './outcome.js'

export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface PingHttpResponse {
  readonly status: number
  readonly headers?: { get(name: string): string | null } | undefined
  readonly bodyUsed?: boolean | undefined
  readonly body?: { cancel(): Promise<void> } | null | undefined
  text?(): Promise<string>
}

export interface PingRequestInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string | undefined
  readonly redirect?: 'manual' | undefined
  readonly signal: AbortSignal
}

export type FetchLike = (url: string, init: PingRequestInit) => Promise<PingHttpResponse>

export type { PingOutcome }

export interface PingResult {
  readonly outcome: PingOutcome
  readonly ok: boolean
  readonly sent: boolean
  readonly monitor: string
  readonly action: PingAction
  readonly status: number | undefined
  readonly attempts: number
  readonly durationMs: number
  readonly retryAfterSeconds: number | undefined
  readonly error: Error | undefined
  // Set only where the outcome has a cause worth a sentence; a surface printing the token loses it.
  readonly message: string | undefined
}

export interface PingOptions {
  readonly body?: string | undefined
  readonly runtimeMs?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly retries?: number | undefined
  readonly truncate?: TruncateMode | undefined
  readonly signal?: AbortSignalLike | undefined
  readonly onResult?: ((result: PingResult) => void) | undefined
}

// A thunk a scheduler calls on every tick carries no body and measures no run, so the
// two options the dispatch would discard are not offered.
export interface CheckInWithOptions extends Omit<PingOptions, 'body' | 'runtimeMs'> {
  readonly action?: PingAction | undefined
}

export interface PingClientOptions {
  readonly baseUrl?: string | undefined
  readonly monitors?: Readonly<Record<string, string>> | undefined
  readonly timeoutMs?: number | undefined
  readonly retries?: number | undefined
  readonly disabled?: boolean | undefined
  readonly fetch?: FetchLike | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly onResult?: ((result: PingResult) => void) | undefined
  readonly truncate?: TruncateMode | undefined
  readonly redact?: readonly (string | RegExp)[] | undefined
  readonly includeStack?: boolean | undefined
  readonly signal?: AbortSignalLike | undefined
  readonly userAgent?: string | undefined
}

export interface MonitorRun {
  success(options?: PingOptions): Promise<PingResult>
  fail(error?: unknown, options?: PingOptions): Promise<PingResult>
}

export type CheckInThunk = (() => void) & {
  flush(timeoutMs?: number): Promise<void>
}

export interface MonitorRegistry {
  define(monitors: Readonly<Record<string, string>>): void
  resolve(name: string): string
  has(name: string): boolean
}

export interface PingClient {
  ping(name: string, options?: PingOptions): Promise<PingResult>
  start(name: string, options?: PingOptions): Promise<PingResult>
  success(name: string, options?: PingOptions): Promise<PingResult>
  fail(name: string, options?: PingOptions): Promise<PingResult>
  withMonitor<T>(name: string, run: () => T | PromiseLike<T>, options?: PingOptions): Promise<Awaited<T>>
  startRun(name: string, options?: PingOptions): MonitorRun
  checkInWith(name: string, options?: CheckInWithOptions): CheckInThunk
  flush(timeoutMs?: number): Promise<void>
  readonly monitors: MonitorRegistry
}
