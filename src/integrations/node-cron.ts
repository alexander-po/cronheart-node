import type { ScheduledTask, TaskContext } from 'node-cron'
import { assertMonitorNamed } from '../wiring/adapters.js'
import { sealed } from '../wiring/validate.js'
import { type AdapterOptions, bracketFor, readOption, wireMonitor } from './run.js'

// Only the four members the adapter touches, so a task of any node-cron flavour satisfies
// it — the inline one and the forked file-path one alike, which a callback wrapper could
// never have reached, because a background task's function does not live in this process.
export type MonitorableTask = Pick<ScheduledTask, 'on' | 'off' | 'getPattern' | 'name'>

export type NodeCronMonitorOptions = AdapterOptions

export interface MonitoredTask {
  detach(): void
  flush(timeoutMs?: number): Promise<void>
}

type TaskListener = (context: TaskContext) => void

const DIALECT = 'node-cron'

const OVERLAP_ADVICE =
  "cronheart: two executions of this task overlapped, so their check-ins were reported as one run — the service reads the span between a start and a terminal check-in as the job's runtime, and interleaved ones would describe a run that never happened. Pass noOverlap: true to node-cron to have it skip an execution while the last one is still going."

function errorIn(context: unknown): unknown {
  try {
    return (context as { execution?: { error?: unknown } } | null | undefined)?.execution?.error
  } catch {
    return undefined
  }
}

function patternOf(task: MonitorableTask): string | undefined {
  try {
    return typeof task.getPattern === 'function' ? task.getPattern() : undefined
  } catch {
    return undefined
  }
}

export function monitor(
  task: MonitorableTask,
  name?: string | undefined,
  options?: NodeCronMonitorOptions,
): MonitoredTask {
  const bracket = sealed('monitor', () => {
    const chosen = name ?? readOption(task, 'name')
    assertMonitorNamed(chosen, 'the task')
    wireMonitor(
      chosen,
      {
        expression: patternOf(task),
        // node-cron keeps the zone in the options the task was created with and exposes
        // none of them, so there is nothing here to check the monitor's zone against.
        zone: undefined,
        dialect: DIALECT,
        zoneOption: "node-cron's timezone option",
      },
      options,
    )

    return bracketFor(chosen, options, OVERLAP_ADVICE)
  })

  const pending = new Set<Promise<void>>()

  // node-cron emits on a bare EventEmitter, which neither awaits a listener nor reads what
  // it returns: a rejection from one is unhandled and a throw takes the emit with it. So the
  // work a listener starts is held here for flush(), which is what a short process waits on.
  const hold = (work: Promise<void>): void => {
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
  }

  const started: TaskListener = () => {
    try {
      bracket.begin()
    } catch {}
  }

  const settled = (failed: boolean): TaskListener => {
    return (context) => {
      try {
        hold(bracket.settle(failed, failed ? errorIn(context) : undefined))
      } catch {}
    }
  }

  const listeners = [
    ['execution:started', started],
    ['execution:finished', settled(false)],
    ['execution:failed', settled(true)],
  ] as const

  for (const [event, listener] of listeners) {
    task.on(event, listener)
  }

  return {
    detach: () => {
      for (const [event, listener] of listeners) {
        try {
          task.off(event, listener)
        } catch {}
      }
    },
    flush: async (timeoutMs?: number): Promise<void> => {
      await Promise.allSettled([...pending])
      await bracket.flush(timeoutMs)
    },
  }
}

// Here rather than on the root, which ships into every bundle a job runs in.
export {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../wiring/errors.js'
