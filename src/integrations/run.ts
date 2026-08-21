import { flush as defaultFlush, monitors as defaultMonitors, startRun as defaultStartRun } from '../index.js'
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

// Resolution happens where the job is wired, so an id nothing defines crashes the deploy
// rather than going quiet at three in the morning.
export function resolveAtWiringTime(name: string, options: AdapterOptions | undefined): void {
  const registry = options?.client?.monitors ?? defaultMonitors

  registry.resolve(name)
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
  const client = options?.client
  const start = client === undefined ? defaultStartRun : (n: string, o: PingOptions) => client.startRun(n, o)
  const drain = client === undefined ? defaultFlush : (ms: number | undefined) => client.flush(ms)
  const shared = callOptions(options)
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
        run = start(name, shared)
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
    flush: (timeoutMs?: number) => drain(timeoutMs),
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
  readonly zoneOption: string
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
  } else if (facts.expression !== undefined) {
    const advice = zoneUnstatedAdvice(facts.expression, name, facts.zoneOption)

    if (advice !== undefined) {
      warnOnce(ZONE_WARNING, name, advice)
    }
  }

  resolveAtWiringTime(name, options)
}

// What a scheduler's options object hands over is the host's, and a getter on one can
// throw. Reading it here rather than in the adapter keeps every such read behind sealed().
export function readOption(source: unknown, key: string): string | undefined {
  try {
    const value = (source as Record<string, unknown> | null | undefined)?.[key]

    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

// croner and cron type their callback as returning nothing and do discard what comes back,
// but the value still has to reach the caller of the wrapper by identity.
export function asVoidReturn(work: Promise<unknown>): Promise<void> {
  return work as Promise<void>
}
