import type { JobCallback, Spec } from 'node-schedule'
import { sealed } from '../wiring/validate.js'
import { type AdapterOptions, bracketFor, bracketed, readOption, wireMonitor } from './run.js'

export type ScheduleRun<T> = (fireDate: Date) => T | PromiseLike<T>

// node-schedule's own scheduleJob arguments, name included: the monitor's name and the
// job's name are then the same string by construction rather than by convention.
export type ScheduleArguments = readonly [name: string, spec: Spec, run: JobCallback]

export type ScheduleMonitorOptions = AdapterOptions

const DIALECT = 'node-schedule'

const OVERLAP_ADVICE =
  "cronheart: two invocations of this job overlapped, so their check-ins were reported as one run — the service reads the span between a start and a terminal check-in as the job's runtime, and interleaved ones would describe a run that never happened. node-schedule has no overlap guard of its own, so the job has to hold that lock itself."

function expressionIn(spec: Spec): string | undefined {
  if (typeof spec === 'string') {
    return spec
  }

  return readOption(spec, 'rule')
}

export function monitored<T>(
  name: string,
  spec: Spec,
  run: ScheduleRun<T>,
  monitorOptions?: ScheduleMonitorOptions,
): ScheduleArguments {
  const bracket = sealed('monitored', () => {
    wireMonitor(
      name,
      {
        expression: expressionIn(spec),
        zone: readOption(spec, 'tz'),
        offset: undefined,
        dialect: DIALECT,
        zoneOption: "the tz field of node-schedule's spec",
      },
      monitorOptions,
    )

    return bracketFor(name, monitorOptions, OVERLAP_ADVICE)
  })

  const wrapped = (fireDate: Date): Promise<unknown> => bracketed(bracket, () => run(fireDate))

  return [name, spec, wrapped]
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
