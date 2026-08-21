import type { Abstract, DynamicModule, Type } from '@nestjs/common'
import type { SchedulerRegistry } from '@nestjs/schedule'
import { sealed } from '../wiring/validate.js'
import {
  type AdapterOptions,
  type MonitorMapping,
  type RunBracket,
  bracketFor,
  bracketed,
  mappedMonitor,
  readCount,
  readMember,
  readOption,
  sinkFor,
  wireMonitor,
} from './run.js'

// Only the member the walk needs, so a registry of any @nestjs/schedule version satisfies
// it and nothing of the framework's is constructed here.
export type ScheduledJobs = Pick<SchedulerRegistry, 'getCronJobs'>

export type SchedulerRegistryToken = Type<ScheduledJobs> | Abstract<ScheduledJobs>

export interface NestMonitorOptions extends AdapterOptions {
  // The name a job is registered under to the monitor it checks in for. false is a job left
  // out on purpose, so it counts towards neither the coverage line nor the total beside it.
  readonly jobs: MonitorMapping
  readonly report?: ((message: string) => void) | undefined
}

export interface NestModuleOptions extends NestMonitorOptions {
  // The framework's own SchedulerRegistry class, passed in as the injection token: the
  // module never imports the scheduler, so the token has to come from the application.
  readonly registry: SchedulerRegistryToken
}

export interface MonitoredSchedule {
  readonly monitored: readonly string[]
  readonly unmapped: readonly string[]
  readonly unwrapped: readonly string[]
  detach(): void
  flush(timeoutMs?: number): Promise<void>
}

type Callback = (this: unknown, ...args: unknown[]) => unknown

interface MappedJob {
  readonly key: string
  readonly monitor: string
  readonly job: unknown
}

interface Survey {
  readonly mapped: readonly MappedJob[]
  readonly unmapped: readonly string[]
  readonly covered: number
}

const DIALECT = '@nestjs/schedule'

const OVERLAP_ADVICE =
  "cronheart: two fires of this job overlapped, so their check-ins were reported as one run — the service reads the span between a start and a terminal check-in as the job's runtime, and interleaved ones would describe a run that never happened. Pass waitForCompletion: true in the job's own schedule options to have the scheduler skip a fire while the last one is still going."

const NOTHING_REGISTERED =
  'cronheart: no cron jobs were registered when this module looked, so nothing is being monitored. Check that the scheduler module is imported and that the decorated methods sit on providers it can reach.'

function callbacksOf(job: unknown): Callback[] | undefined {
  const held = readMember(job, '_callbacks')

  if (!Array.isArray(held) || held.length === 0) {
    return undefined
  }

  return held.every((callback) => typeof callback === 'function')
    ? (held as Callback[])
    : undefined
}

function survey(registry: ScheduledJobs, options: NestMonitorOptions): Survey {
  const mapped: MappedJob[] = []
  const unmapped: string[] = []
  let excluded = 0
  let total = 0

  for (const [key, job] of registry.getCronJobs()) {
    const monitor = mappedMonitor(options.jobs, key)
    total += 1

    if (monitor === false) {
      excluded += 1
    } else if (monitor === undefined) {
      unmapped.push(key)
    } else {
      mapped.push({ key, monitor, job })
    }
  }

  // Every mapped job is checked before any of them is wrapped, so a schedule the service
  // would refuse stops the application starting rather than leaving half a fleet monitored.
  for (const one of mapped) {
    const time = readMember(one.job, 'cronTime')

    wireMonitor(
      one.monitor,
      {
        expression: readOption(time, 'source'),
        zone: readOption(time, 'timeZone'),
        offset: readCount(time, 'utcOffset'),
        dialect: DIALECT,
        zoneOption: "the timeZone option of the job's own schedule decorator",
      },
      options,
    )
  }

  return { mapped, unmapped, covered: total - excluded }
}

function coverageLine(
  monitored: readonly string[],
  unmapped: readonly string[],
  unwrapped: readonly string[],
  covered: number,
): string {
  if (covered === 0 && unwrapped.length === 0) {
    return NOTHING_REGISTERED
  }

  const clauses = [
    `cronheart: monitoring ${monitored.length} of ${covered} cron ${covered === 1 ? 'job' : 'jobs'}`,
  ]

  if (unmapped.length > 0) {
    clauses.push(`unmapped: ${unmapped.join(', ')}`)
  }

  if (unwrapped.length > 0) {
    clauses.push(
      `could not be wrapped: ${unwrapped.join(', ')} — the scheduler holds those jobs' callbacks somewhere this adapter cannot reach`,
    )
  }

  return `${clauses.join('; ')}.`
}

interface ConsoleLike {
  warn?: (message: string) => void
  info?: (message: string) => void
  log?: (message: string) => void
}

// A line nobody can see is a coverage report that does not exist, so it goes to the sink
// the caller named, and otherwise to the one an operator is already reading: a warning
// where something is uncovered, and an ordinary line where nothing is.
function announce(options: NestMonitorOptions, message: string, actionable: boolean): void {
  const written = options.report

  try {
    if (written !== undefined) {
      written(message)

      return
    }

    const sink = (globalThis as { console?: ConsoleLike }).console
    const write = (actionable ? sink?.warn : sink?.info) ?? sink?.log

    if (typeof write === 'function') {
      write.call(sink, message)
    }
  } catch {}
}

function wrapJob(one: MappedJob, options: NestMonitorOptions): (() => void) | undefined {
  const callbacks = callbacksOf(one.job)

  if (callbacks === undefined) {
    return undefined
  }

  const originals = [...callbacks]
  const bracket: RunBracket = bracketFor(one.monitor, options, OVERLAP_ADVICE)

  for (const [index, original] of originals.entries()) {
    callbacks[index] = function (this: unknown, ...given: unknown[]): unknown {
      const self: unknown = this

      return bracketed(bracket, () => original.apply(self, given))
    }
  }

  return () => {
    for (const [index, original] of originals.entries()) {
      callbacks[index] = original
    }
  }
}

export function monitorScheduledJobs(
  registry: ScheduledJobs,
  options: NestMonitorOptions,
): MonitoredSchedule {
  return sealed('monitorScheduledJobs', () => attach(registry, options))
}

function attach(registry: ScheduledJobs, options: NestMonitorOptions): MonitoredSchedule {
  const sink = sinkFor(options)
  const found = survey(registry, options)
  const monitored: string[] = []
  const unwrapped: string[] = []
  const restores: (() => void)[] = []

  for (const one of found.mapped) {
    const restore = wrapJob(one, options)

    if (restore === undefined) {
      unwrapped.push(one.key)

      continue
    }

    restores.push(restore)
    monitored.push(one.key)
  }

  announce(
    options,
    coverageLine(monitored, found.unmapped, unwrapped, found.covered),
    found.unmapped.length > 0 || unwrapped.length > 0 || found.covered === 0,
  )

  return {
    monitored,
    unmapped: found.unmapped,
    unwrapped,
    detach: () => {
      for (const restore of restores) {
        restore()
      }
    },
    flush: (timeoutMs?: number) => sink.client.flush(timeoutMs),
  }
}

// A provider rather than a decorator: the registry is walked once the application has
// booted, so every job the scheduler ended up with is seen whatever order the decorators
// ran in — and what is left uncovered is said out loud instead of being nothing at all.
export class CronheartModule {
  static forRoot(options: NestModuleOptions): DynamicModule {
    const token = sealed('CronheartModule.forRoot', () => options.registry)

    return {
      module: CronheartModule,
      providers: [
        {
          provide: Symbol.for('cronheart.nestjs.monitoredSchedule'),
          useFactory: (registry: ScheduledJobs) => {
            let attached: MonitoredSchedule | undefined

            return {
              onApplicationBootstrap: () => {
                attached = monitorScheduledJobs(registry, options)
              },
              onApplicationShutdown: async (): Promise<void> => {
                await attached?.flush()
              },
            }
          },
          inject: [token],
        },
      ],
    }
  }
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
