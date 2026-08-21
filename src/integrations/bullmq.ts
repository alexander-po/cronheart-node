import type { Processor, WorkerOptions } from 'bullmq'
import { cronDialectRefusal } from '../cron-dialect.js'
import { labelFor } from '../ping/resolve.js'
import { rethrow } from '../ping/safely.js'
import { warnOnce } from '../ping/warn.js'
import { sealed } from '../wiring/validate.js'
import {
  type AdapterOptions,
  type MonitorMapping,
  type RunSink,
  mappedMonitor,
  readCount,
  readMember,
  readOption,
  reportRun,
  resolveAtWiringTime,
  sinkFor,
} from './run.js'

export interface BullMqMonitorOptions extends AdapterOptions {
  // Job name to monitor name. One worker carries every job name on its queue, and only the
  // ones named here check in; false leaves a job out on purpose rather than by omission.
  readonly jobs: MonitorMapping
  readonly pingStart?: boolean | undefined
  readonly allowOneOff?: boolean | undefined
}

// bullmq's own Worker constructor arguments, so the options the parallelism is read from
// are by construction the options the worker runs under.
export type WorkerArguments<D, R, N extends string> = readonly [
  queue: string,
  process: Processor<D, R, N>,
  options: WorkerOptions,
]

const DIALECT = 'bullmq'

const ONE_OFF_WARNING = 'bullmq-one-off'

const PARALLEL_WARNING = 'bullmq-parallel'

const DIALECT_WARNING = 'bullmq-dialect'

interface WiredWorker {
  readonly jobs: MonitorMapping
  readonly sink: RunSink
  readonly withStart: boolean
  readonly allowOneOff: boolean
}

function oneOffAdvice(monitor: string): string {
  return `cronheart: a job named for ${JSON.stringify(labelFor(monitor))} ran without being on a repeating schedule, so no check-in was sent — a monitor stands for a schedule, and a job added by hand arriving early or not at all says nothing about one. Put the job on a job scheduler, or pass allowOneOff: true to check in for it anyway.`
}

function parallelAdvice(queue: string, concurrency: number): string {
  return `cronheart: the worker for ${JSON.stringify(queue)} runs up to ${concurrency} jobs at once, so no start check-ins are sent — parallel runs of one job name would interleave them, and the service reads the span between a start and a terminal check-in as one run's duration. Each run still reports how long it took. Pass pingStart: true to send them anyway, or give the monitored jobs a worker whose concurrency is 1.`
}

function dialectAdvice(monitor: string, refusal: string): string {
  return `cronheart: the repeat pattern of the job checking in for ${JSON.stringify(labelFor(monitor))} is one the service will not hold, so the monitor's schedule is not the job's. ${refusal}`
}

function repeatOptionsOf(job: unknown): unknown {
  return readMember(readMember(job, 'opts'), 'repeat')
}

function isRepeating(job: unknown): boolean {
  return readOption(job, 'repeatJobKey') !== undefined || repeatOptionsOf(job) !== undefined
}

// bullmq counts an attempt as started when the job is moved to active and as made once it
// has failed, so inside the processor the first attempt reads one started and none made.
// Either alone is off by one against the other, so the count comes from whichever is there.
function isFinalAttempt(job: unknown): boolean {
  const configured = readCount(readMember(job, 'opts'), 'attempts')
  const total = configured !== undefined && configured > 0 ? configured : 1
  const started = readCount(job, 'attemptsStarted')
  const made = readCount(job, 'attemptsMade')
  const spent = started !== undefined && started > 0 ? started : (made ?? 0) + 1

  return spent >= total
}

function warnOfDialect(job: unknown, monitor: string): void {
  const pattern = readOption(repeatOptionsOf(job), 'pattern')

  if (pattern === undefined) {
    return
  }

  const refusal = cronDialectRefusal(pattern, DIALECT)

  if (refusal !== undefined) {
    warnOnce(DIALECT_WARNING, monitor, dialectAdvice(monitor, refusal))
  }
}

function wire(
  queue: string,
  options: WorkerOptions,
  monitorOptions: BullMqMonitorOptions,
): WiredWorker {
  const jobs = monitorOptions.jobs
  const asked = monitorOptions.pingStart
  const concurrency = readCount(options, 'concurrency') ?? 1
  const parallel = concurrency > 1

  for (const monitor of Object.values(jobs)) {
    if (typeof monitor === 'string') {
      resolveAtWiringTime(monitor, monitorOptions)
    }
  }

  if (asked === undefined && parallel) {
    warnOnce(PARALLEL_WARNING, queue, parallelAdvice(queue, concurrency))
  }

  return {
    jobs,
    sink: sinkFor(monitorOptions),
    withStart: asked ?? !parallel,
    allowOneOff: monitorOptions.allowOneOff === true,
  }
}

async function bracket<R>(wired: WiredWorker, job: unknown, run: () => Promise<R>): Promise<R> {
  const monitor = mappedMonitor(wired.jobs, readOption(job, 'name'))

  if (typeof monitor !== 'string') {
    return run()
  }

  if (!wired.allowOneOff && !isRepeating(job)) {
    warnOnce(ONE_OFF_WARNING, monitor, oneOffAdvice(monitor))

    return run()
  }

  warnOfDialect(job, monitor)

  const report = reportRun(wired.sink, monitor, wired.withStart)
  let value: R

  try {
    value = await run()
  } catch (error) {
    // Every attempt but the last is one the queue will make again, and a fail check-in for
    // one of those marks the monitor down over a run the queue has not given up on.
    if (isFinalAttempt(job)) {
      await report.fail(error)
    }

    return rethrow<R>(error)
  }

  await report.success()

  return value
}

export function monitored<D, R, N extends string>(
  queue: string,
  options: WorkerOptions,
  process: Processor<D, R, N>,
  monitorOptions: BullMqMonitorOptions,
): WorkerArguments<D, R, N> {
  const wired = sealed('monitored', () => wire(queue, options, monitorOptions))

  const wrapped = function (this: unknown, ...given: Parameters<Processor<D, R, N>>): Promise<R> {
    const self: unknown = this

    return bracket(wired, given[0], () =>
      (process as (this: unknown, ...args: unknown[]) => Promise<R>).apply(self, given),
    )
  }

  return [queue, wrapped as Processor<D, R, N>, options]
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
