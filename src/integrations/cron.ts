import type { CronJobParams } from 'cron'
import { sealed } from '../wiring/validate.js'
import {
  type AdapterOptions,
  asVoidReturn,
  bracketFor,
  bracketed,
  readCount,
  readOption,
  wireMonitor,
} from './run.js'

export type CronMonitorOptions = AdapterOptions

// cron's onTick also admits a shell command string, which nothing in this process could
// bracket — the CLI wrapper is for that. What is left is the callback form, widened in its
// return type, because cron's says a tick returns nothing while the value still has to
// reach the caller of the wrapper by identity.
export type CronParamsLike = Pick<CronJobParams, 'cronTime'> & {
  readonly onTick: (this: never, ...args: never[]) => unknown
}

const DIALECT = 'cron'

const OVERLAP_ADVICE =
  "cronheart: two ticks of this job overlapped, so their check-ins were reported as one run — the service reads the span between a start and a terminal check-in as the job's runtime, and interleaved ones would describe a run that never happened. cron 4 takes waitForCompletion: true, which holds a tick until the last one finishes; cron 3 has no such option, so there the job has to hold that lock itself."

export function monitored<P extends CronParamsLike>(
  name: string,
  params: P,
  monitorOptions?: CronMonitorOptions,
): P {
  const bracket = sealed('monitored', () => {
    wireMonitor(
      name,
      {
        expression: readOption(params, 'cronTime'),
        zone: readOption(params, 'timeZone'),
        offset: readCount(params, 'utcOffset'),
        dialect: DIALECT,
        zoneOption: "cron's timeZone parameter",
      },
      monitorOptions,
    )

    return bracketFor(name, monitorOptions, OVERLAP_ADVICE)
  })
  const original = params.onTick

  // A function expression, not an arrow: cron calls the tick with the job (or the context
  // the job was given) as its receiver, and an arrow would silently swallow it.
  const onTick = function (this: unknown, ...given: unknown[]): Promise<void> {
    const self: unknown = this

    return asVoidReturn(
      bracketed(bracket, () =>
        (original as (this: unknown, ...args: unknown[]) => unknown).apply(self, given),
      ),
    )
  }

  // Everything else is handed straight back, so a field cron gains tomorrow needs no change.
  return { ...params, onTick } as unknown as P
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
