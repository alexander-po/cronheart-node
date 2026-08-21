import { describeError } from '../ping/client.js'
import { defaultClient } from '../ping/default.js'
import { rethrow } from '../ping/safely.js'
import type { MonitorRun, PingClient, PingOptions, PingResult } from '../ping/types.js'
import { warnOnce } from '../ping/warn.js'
import { assertServiceCron, assertTimezone, zoneUnstatedAdvice } from '../wiring/adapters.js'

export interface AdapterOptions {
  // The client whose check-ins the adapter sends. Omitted, it is the one the package's own
  // entry points share, so flush() from 'cronheart' covers what an adapter started.
  readonly client?: PingClient | undefined
  readonly timeoutMs?: number | undefined
  readonly retries?: number | undefined
  readonly onResult?: ((result: PingResult) => void) | undefined
}

export interface RunBracket {
  begin(): void
  settle(failed: boolean, error: unknown): Promise<void>
  flush(timeoutMs?: number): Promise<void>
}

const OVERLAP_WARNING = 'adapter-overlap'

const ZONE_WARNING = 'adapter-zone'

function callOptions(options: AdapterOptions | undefined): PingOptions {
  const built: Record<string, unknown> = {}

  if (options?.timeoutMs !== undefined) {
    built['timeoutMs'] = options.timeoutMs
  }

  if (options?.retries !== undefined) {
    built['retries'] = options.retries
  }

  if (options?.onResult !== undefined) {
    built['onResult'] = options.onResult
  }

  return built as PingOptions
}

export interface RunSink {
  readonly client: PingClient
  readonly options: PingOptions
}

// Built where the job is wired, never on the job's own frame: what the caller passed is an
// object the host wrote, and a getter on one of those can throw.
export function sinkFor(options: AdapterOptions | undefined): RunSink {
  return { client: options?.client ?? defaultClient(), options: callOptions(options) }
}

// Resolution happens where the job is wired, so an id nothing defines crashes the deploy
// rather than going quiet at three in the morning.
export function resolveAtWiringTime(name: string, options: AdapterOptions | undefined): void {
  sinkFor(options).client.monitors.resolve(name)
}

// One bracket at a time, whatever the scheduler does. Two runs in flight would interleave a
// start and a terminal check-in, and the service reads the span between them as the job's
// runtime — so what it stored would describe a run that never happened. The collapse never
// skips the job; it reports overlapping runs as one, failed if any of them failed.
export function bracketFor(
  name: string,
  options: AdapterOptions | undefined,
  overlapAdvice: string,
): RunBracket {
  const { client, options: shared } = sinkFor(options)
  let open = 0
  let run: MonitorRun | undefined
  let failed = false
  let failure: unknown

  return {
    begin: () => {
      open += 1

      if (open > 1) {
        warnOnce(OVERLAP_WARNING, name, overlapAdvice)

        return
      }

      failed = false
      failure = undefined

      try {
        run = client.startRun(name, shared)
      } catch {
        run = undefined
      }
    },
    settle: async (threw: boolean, error: unknown): Promise<void> => {
      if (threw && !failed) {
        failed = true
        failure = error
      }

      open = open > 0 ? open - 1 : 0

      if (open > 0) {
        return
      }

      const active = run
      run = undefined

      if (active === undefined) {
        return
      }

      const terminal = failed ? active.fail(failure) : active.success()
      failed = false
      failure = undefined

      await terminal
    },
    flush: (timeoutMs?: number) => client.flush(timeoutMs),
  }
}

// Nothing the host returns or throws is read here — the value goes back by identity and the
// error as the same object, so the scheduler still sees the run it would have seen.
export async function bracketed<T>(
  bracket: RunBracket,
  run: () => T | PromiseLike<T>,
): Promise<Awaited<T>> {
  bracket.begin()

  let value: Awaited<T>

  try {
    value = (await run()) as Awaited<T>
  } catch (error) {
    await bracket.settle(true, error)

    return rethrow<Awaited<T>>(error)
  }

  await bracket.settle(false, undefined)

  return value
}

export interface ScheduleFacts {
  // undefined where the scheduler was given a date or a rule object rather than an
  // expression: there is no dialect to disagree about, so there is nothing to refuse.
  readonly expression: string | undefined
  readonly zone: string | undefined
  readonly dialect: string
  // undefined where the adapter cannot see whether the scheduler was given a zone: an
  // absent zone is then no evidence that none was named, and advice drawn from it would
  // be wrong as often as the caller had named one.
  readonly zoneOption: string | undefined
  // A UTC offset is the other way of naming a zone, and every scheduler that takes one
  // takes it instead of the name. So an absent zone alongside an offset is evidence that
  // a zone was named, not that none was.
  readonly offset: number | undefined
}

export function wireMonitor(
  name: string,
  facts: ScheduleFacts,
  options: AdapterOptions | undefined,
): void {
  if (facts.expression !== undefined) {
    assertServiceCron(facts.expression, name, facts.dialect)
  }

  if (facts.zone !== undefined) {
    assertTimezone(facts.zone, name)
  } else if (
    facts.expression !== undefined &&
    facts.zoneOption !== undefined &&
    facts.offset === undefined
  ) {
    const advice = zoneUnstatedAdvice(facts.expression, name, facts.zoneOption)

    if (advice !== undefined) {
      warnOnce(ZONE_WARNING, name, advice)
    }
  }

  resolveAtWiringTime(name, options)
}

// What a scheduler's options object hands over is the host's, and a getter on one can
// throw. Reading it here rather than in the adapter keeps every such read behind sealed().
export function readMember(source: unknown, key: string): unknown {
  try {
    return (source as Record<string, unknown> | null | undefined)?.[key]
  } catch {
    return undefined
  }
}

export function readOption(source: unknown, key: string): string | undefined {
  const value = readMember(source, key)

  return typeof value === 'string' ? value : undefined
}

export function readCount(source: unknown, key: string): number | undefined {
  const value = readMember(source, key)

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export type MonitorMapping = Readonly<Record<string, string | false>>

// A worker or a scheduler carries jobs the mapping says nothing about, so a lookup that
// finds nothing is the ordinary case rather than a fault. false is a job the caller has
// deliberately left out, which is not the same answer as one nobody has decided about.
export function mappedMonitor(mapping: MonitorMapping, job: string | undefined): string | false | undefined {
  if (job === undefined || !Object.hasOwn(mapping, job)) {
    return undefined
  }

  const named = mapping[job]

  return typeof named === 'string' || named === false ? named : undefined
}

export interface RunReport {
  success(): Promise<void>
  fail(error: unknown): Promise<void>
}

// One run reported on its own rather than through a shared bracket, and with the start
// check-in optional: a worker running jobs in parallel would interleave the starts of runs
// that are genuinely separate, and the service reads the span between a start and a
// terminal check-in as one run's duration. Without a start, the duration is measured here
// and carried on the terminal check-in instead.
export function reportRun(sink: RunSink, name: string, withStart: boolean): RunReport {
  const { client, options: shared } = sink
  const startedAt = Date.now()
  let run: MonitorRun | undefined

  if (withStart) {
    try {
      run = client.startRun(name, shared)
    } catch {
      run = undefined
    }
  }

  const terminal = async (failed: boolean, error: unknown): Promise<void> => {
    try {
      if (run !== undefined) {
        await (failed ? run.fail(error) : run.success())

        return
      }

      const described = failed ? describeError(error, false) : undefined

      await client[failed ? 'fail' : 'success'](name, {
        ...shared,
        runtimeMs: Date.now() - startedAt,
        ...(described === undefined ? {} : { body: described }),
      })
    } catch {}
  }

  return {
    success: () => terminal(false, undefined),
    fail: (error) => terminal(true, error),
  }
}


// croner and cron type their callback as returning nothing and do discard what comes back,
// but the value still has to reach the caller of the wrapper by identity.
export function asVoidReturn(work: Promise<unknown>): Promise<void> {
  return work as Promise<void>
}
