import {
  DEFAULT_BASE_URL,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  RUNTIME_HEADER_MAX_VALUE,
  RUNTIME_HEADER_NAME,
} from '../constants.js'
import { TransportFailure, send as transportSend } from '../transport/send.js'
import { parseRetryAfter } from '../transport/retry-after.js'
import {
  assertEmittableAction,
  assertPingBaseUrl,
  defineMonitors,
  pingPath,
  resolveOrThrow,
} from '../wiring/validate.js'
import { countdown } from '../timer.js'
import { userAgent } from '../version.js'
import { type PingAction, isTerminal } from './action.js'
import { type TruncateMode, inAnyCase, redactSecrets, truncateBody } from './body.js'
import { ambientEnv, isDisabled, numberFrom, readEnv } from './env.js'
import { classifyStatus, isAccepted, isConfigurationOutcome } from './outcome.js'
import { type Resolution, labelFor, resolveMonitor } from './resolve.js'
import { rethrow, safely, toError } from './safely.js'
import type {
  CheckInThunk,
  CheckInWithOptions,
  MonitorRegistry,
  MonitorRun,
  PingClient,
  PingClientOptions,
  PingOptions,
  PingOutcome,
  PingResult,
} from './types.js'
import { warnOnce } from './warn.js'

const DEFAULT_FLUSH_TIMEOUT_MS = 5000

// What the entry points hand to dispatch alongside the caller's own option objects: every
// read of those happens inside the guard rather than on the job's frame.
interface CallShape {
  readonly transportOnly?: boolean | undefined
  readonly runtimeMs?: number | undefined
  readonly bodyFallback?: (() => string | undefined) | undefined
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function ignore(): void {}

// onResult is typed as returning void, which permits an async one — and an async sink
// that rejects would otherwise leave an unhandled rejection behind every check-in.
function settleQuietly(returned: unknown): void {
  if (typeof (returned as { then?: unknown } | null | undefined)?.then === 'function') {
    void Promise.resolve(returned as PromiseLike<unknown>).then(ignore, ignore)
  }
}

function runtimeHeaderValue(runtimeMs: number | undefined): string | undefined {
  if (typeof runtimeMs !== 'number' || !Number.isFinite(runtimeMs) || runtimeMs < 0) {
    return undefined
  }

  const whole = Math.round(runtimeMs)

  // Clamping would hand the server a duration the job never took, and it would store it as real.
  return whole > RUNTIME_HEADER_MAX_VALUE ? undefined : String(whole)
}

// Total by construction: the accessors it reads belong to the host's error, and in V8
// reading a stack runs whatever the host installed as Error.prepareStackTrace.
function describeError(error: unknown, includeStack: boolean): string {
  try {
    const failure = toError(error)

    if (includeStack) {
      const stack = failure.stack

      if (typeof stack === 'string') {
        return stack
      }
    }

    return `${failure.name}: ${failure.message}`
  } catch {
    return 'the job failed with an error that cannot be described'
  }
}

function layered(sources: readonly (PingOptions | undefined)[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}

  for (const source of sources) {
    if (source === undefined) {
      continue
    }

    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        merged[key] = value
      }
    }
  }

  return merged
}

function callOptionsFrom(
  sources: readonly (PingOptions | undefined)[],
  shape: CallShape | undefined,
): PingOptions {
  const { body: givenBody, runtimeMs: givenRuntime, ...rest } = layered(sources)
  const carried = shape?.transportOnly === true
  const body = carried ? undefined : (givenBody ?? shape?.bodyFallback?.())
  const runtimeMs = shape?.runtimeMs ?? (carried ? undefined : givenRuntime)
  const next: Record<string, unknown> = { ...rest }

  if (body !== undefined) {
    next['body'] = body
  }

  if (runtimeMs !== undefined) {
    next['runtimeMs'] = runtimeMs
  }

  return next as PingOptions
}

function messageFor(outcome: PingOutcome, resolution: Resolution): string | undefined {
  if (!isConfigurationOutcome(outcome)) {
    return undefined
  }

  const monitor = JSON.stringify(resolution.label)
  const envVar = resolution.envVar

  if (outcome === 'disabled') {
    return `CRONHEART_DISABLED is set, so no check-in was sent for ${monitor}. Unset it to resume monitoring.`
  }

  if (outcome === 'suppressed') {
    if (envVar === undefined || resolution.reason === 'malformed') {
      const source = envVar === undefined ? 'the id passed for it' : `the value ${envVar} holds`
      return `${source} is not a monitor id, so nothing was sent for ${monitor}.`
    }

    return `no monitor id for ${monitor}, so nothing was sent. Set ${envVar}, or pass monitors: { … } to createPingClient.`
  }

  if (outcome === 'not-found') {
    const where = envVar === undefined ? 'the id it was given' : envVar
    return `the server does not recognise the monitor for ${monitor} (HTTP 404). Check ${where}.`
  }

  if (outcome === 'paused') {
    return `the monitor for ${monitor} is paused (HTTP 410). Check-ins are recorded, but no alert will fire.`
  }

  return undefined
}

export function createPingClient(options: PingClientOptions = {}): PingClient {
  const env = options.env ?? ambientEnv()
  const baseUrl = (options.baseUrl ?? readEnv(env, 'URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = positiveOr(options.timeoutMs ?? numberFrom(env, 'TIMEOUT_MS'), DEFAULT_TIMEOUT_MS)
  const retries = nonNegativeOr(options.retries ?? numberFrom(env, 'RETRIES'), DEFAULT_RETRIES)
  const disabled = options.disabled ?? isDisabled(env)
  const truncate: TruncateMode = options.truncate ?? 'head'
  const includeStack = options.includeStack ?? false
  const redact = options.redact ?? []
  const defined: Record<string, string> = {}
  const inFlight = new Set<Promise<PingResult>>()

  assertPingBaseUrl(baseUrl)

  if (options.monitors !== undefined) {
    defineMonitors(defined, options.monitors)
  }

  const monitors: MonitorRegistry = {
    define: (next) => {
      defineMonitors(defined, next)
    },
    resolve: (name) => resolveOrThrow(name, defined, env),
    has: (name) => resolveMonitor(name, defined, env).id !== undefined,
  }

  function report(
    result: PingResult,
    resolution: Resolution,
    callOptions: PingOptions | undefined,
  ): void {
    try {
      const sink = callOptions?.onResult ?? options.onResult

      if (sink !== undefined) {
        settleQuietly(sink(result))

        return
      }

      if (result.message !== undefined) {
        warnOnce(
          result.outcome,
          resolution.envVar ?? resolution.label,
          `cronheart: ${result.message}`,
        )
      }
    } catch {}
  }

  async function perform(
    name: string,
    action: PingAction,
    callOptions: PingOptions,
    fallback: PingResult,
    startedAt: number,
  ): Promise<PingResult> {
    const resolution = resolveMonitor(name, defined, env)
    const finish = (partial: Partial<PingResult>): PingResult => {
      const result: PingResult = {
        ...fallback,
        ...partial,
        monitor: resolution.label,
        durationMs: Date.now() - startedAt,
        message: messageFor(partial.outcome ?? fallback.outcome, resolution),
      }

      report(result, resolution, callOptions)

      return result
    }

    if (disabled) {
      return finish({ outcome: 'disabled' })
    }

    if (resolution.id === undefined) {
      return finish({ outcome: 'suppressed' })
    }

    const rawBody = callOptions.body
    const body =
      rawBody === undefined
        ? undefined
        : truncateBody(
            // The id is matched in either case: it is configured in one and echoed by the
            // server in the other, and a failure body is where a job's own ping line lands.
            redactSecrets(String(rawBody), [inAnyCase(resolution.id), ...redact]),
            callOptions.truncate ?? truncate,
          )
    const runtime = isTerminal(action) ? runtimeHeaderValue(callOptions.runtimeMs) : undefined

    const headers: Record<string, string> = {
      Accept: 'text/plain',
      'User-Agent': options.userAgent ?? userAgent(),
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'text/plain; charset=utf-8'
    }

    if (runtime !== undefined) {
      headers[RUNTIME_HEADER_NAME] = runtime
    }

    try {
      const response = await transportSend({
        url: `${baseUrl}/ping/${resolution.id}${pingPath(action)}`,
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body,
        timeoutMs: positiveOr(callOptions.timeoutMs, timeoutMs),
        retries: nonNegativeOr(callOptions.retries, retries),
        signal: callOptions.signal ?? options.signal,
        fetch: options.fetch,
      })
      const outcome = classifyStatus(response.status, response.body)

      return finish({
        outcome,
        ok: isAccepted(outcome),
        sent: true,
        status: response.status,
        attempts: response.attempts,
        retryAfterSeconds: parseRetryAfter(response.retryAfter, Date.now()),
      })
    } catch (error) {
      const failure = error instanceof TransportFailure ? error : undefined

      return finish({
        outcome: failure?.reason ?? 'unexpected',
        sent: (failure?.attempts ?? 0) > 0,
        attempts: failure?.attempts ?? 0,
        error: toError(error),
      })
    }
  }

  function track(promise: Promise<PingResult>): Promise<PingResult> {
    inFlight.add(promise)
    void promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    )

    return promise
  }

  function dispatch(
    name: string,
    action: PingAction,
    sources: readonly (PingOptions | undefined)[],
    shape?: CallShape,
  ): Promise<PingResult> {
    const startedAt = Date.now()
    const fallback: PingResult = {
      outcome: 'unexpected',
      ok: false,
      sent: false,
      monitor: labelFor(name),
      action,
      status: undefined,
      attempts: 0,
      durationMs: 0,
      retryAfterSeconds: undefined,
      error: undefined,
      message: undefined,
    }

    return track(
      safely(fallback, () =>
        perform(name, action, callOptionsFrom(sources, shape), fallback, startedAt),
      ),
    )
  }

  async function flush(timeoutMs?: number): Promise<void> {
    const pending = [...inFlight]

    if (pending.length === 0) {
      return
    }

    const deadline = countdown(positiveOr(timeoutMs, DEFAULT_FLUSH_TIMEOUT_MS))

    try {
      await Promise.race([Promise.allSettled(pending), deadline.reached])
    } finally {
      deadline.cancel()
    }
  }

  async function settleHost<T>(
    run: () => T | PromiseLike<T>,
  ): Promise<{ ok: true; value: Awaited<T> } | { ok: false; error: unknown }> {
    try {
      return { ok: true, value: (await run()) as Awaited<T> }
    } catch (error) {
      return { ok: false, error }
    }
  }

  function startRun(name: string, runOptions?: PingOptions): MonitorRun {
    const startedAt = Date.now()
    void dispatch(name, 'start', [runOptions], { transportOnly: true })
    let terminal: Promise<PingResult> | undefined

    const sendTerminal = (
      action: PingAction,
      callOptions: PingOptions | undefined,
      bodyFallback?: () => string | undefined,
    ): Promise<PingResult> => {
      terminal ??= dispatch(name, action, [runOptions, callOptions], {
        runtimeMs: Date.now() - startedAt,
        bodyFallback,
      })

      return terminal
    }

    return {
      success: (successOptions) => sendTerminal('success', successOptions),
      fail: (error, failOptions) =>
        sendTerminal('fail', failOptions, () =>
          error === undefined ? undefined : describeError(error, includeStack),
        ),
    }
  }

  // One bracket, not two: the start check-in is dispatched without being awaited here as
  // it is in startRun, because a job must not wait on the network to begin and a stalled
  // start would otherwise hold it for the whole timeout budget.
  async function withMonitor<T>(
    name: string,
    run: () => T | PromiseLike<T>,
    runOptions?: PingOptions,
  ): Promise<Awaited<T>> {
    const monitored = startRun(name, runOptions)
    const settled = await settleHost(run)

    if (settled.ok) {
      await monitored.success()

      return settled.value
    }

    await monitored.fail(settled.error)

    return rethrow<Awaited<T>>(settled.error)
  }

  function checkInWith(name: string, thunkOptions?: CheckInWithOptions): CheckInThunk {
    const action = thunkOptions?.action ?? 'heartbeat'
    assertEmittableAction(action === 'heartbeat' ? null : action)
    resolveOrThrow(name, defined, env)

    const thunk = (): void => {
      void dispatch(name, action, [thunkOptions], { transportOnly: true })
    }

    return Object.assign(thunk, { flush })
  }

  return {
    ping: (name, callOptions) => dispatch(name, 'heartbeat', [callOptions]),
    start: (name, callOptions) => dispatch(name, 'start', [callOptions]),
    success: (name, callOptions) => dispatch(name, 'success', [callOptions]),
    fail: (name, callOptions) => dispatch(name, 'fail', [callOptions]),
    withMonitor,
    startRun,
    checkInWith,
    flush,
    monitors,
  }
}
