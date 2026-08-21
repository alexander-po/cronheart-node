import type { Cron, CronOptions } from 'croner'
import { sealed } from '../wiring/validate.js'
import {
  type AdapterOptions,
  asVoidReturn,
  bracketFor,
  bracketed,
  readOption,
  wireMonitor,
} from './run.js'

export type CronerRun<T> = (self: Cron, context: unknown) => T | PromiseLike<T>

export type CronerCallback = (self: Cron, context: unknown) => Promise<void>

// croner's own constructor arguments, so the call site spreads them straight in and the
// pattern the monitor is checked against is by construction the pattern croner runs.
export type CronerArguments = readonly [
  pattern: string,
  options: CronOptions,
  run: CronerCallback,
]

export type CronerMonitorOptions = AdapterOptions

const DIALECT = 'croner'

const OVERLAP_ADVICE =
  "cronheart: two runs of this job overlapped, so their check-ins were reported as one run — the service reads the span between a start and a terminal check-in as the job's runtime, and interleaved ones would describe a run that never happened. Pass protect: true to croner to have it skip a tick while the last one is still going."

export function monitored<T>(
  name: string,
  pattern: string,
  options: CronOptions,
  run: CronerRun<T>,
  monitorOptions?: CronerMonitorOptions,
): CronerArguments {
  const bracket = sealed('monitored', () => {
    wireMonitor(
      name,
      {
        expression: pattern,
        zone: readOption(options, 'timezone'),
        dialect: DIALECT,
        zoneOption: "croner's timezone option",
      },
      monitorOptions,
    )

    return bracketFor(name, monitorOptions, OVERLAP_ADVICE)
  })

  const wrapped = function (self: Cron, context: unknown): Promise<void> {
    return asVoidReturn(bracketed(bracket, () => run(self, context)))
  }

  return [pattern, options, wrapped]
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
