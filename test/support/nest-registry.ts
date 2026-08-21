import type { ScheduledJobs } from '../../src/integrations/nestjs.js'

type Callback = (this: unknown, ...args: unknown[]) => unknown

export interface FakeCronJob {
  readonly cronTime: { source: string | undefined; timeZone?: string | undefined }
  fire(): Promise<unknown>
  callbacks(): readonly Callback[]
}

// The half of cron's CronJob the adapter reaches for. `_callbacks` is where the scheduler
// keeps the function it will call, and firing walks that array rather than a captured
// reference, so a job whose callback was replaced runs the replacement.
export function fakeCronJob(
  pattern: string | undefined,
  run: () => unknown,
  zone?: string,
): FakeCronJob {
  const callbackList: Callback[] = [run as Callback]
  const context = { name: 'the job context' }

  return {
    cronTime: { source: pattern, ...(zone === undefined ? {} : { timeZone: zone }) },
    _callbacks: callbackList,
    context,
    fire: async () => {
      let last: unknown

      for (const callback of [...callbackList]) {
        last = await callback.call(context)
      }

      return last
    },
    callbacks: () => [...callbackList],
  } as unknown as FakeCronJob
}

// A registered job that keeps its callback somewhere the adapter cannot see. Wrapping it is
// impossible, and the failure mode this exists to catch is doing that silently.
export function opaqueCronJob(pattern: string): FakeCronJob {
  return { cronTime: { source: pattern }, fire: () => Promise.resolve(), callbacks: () => [] }
}

export function fakeRegistry(jobs: Readonly<Record<string, FakeCronJob>>): ScheduledJobs {
  const registered = new Map(Object.entries(jobs))

  return { getCronJobs: () => registered } as unknown as ScheduledJobs
}

export function explodingRegistry(): ScheduledJobs {
  return {
    getCronJobs: () => {
      throw new TypeError('the registry exploded when asked for its jobs')
    },
  } as unknown as ScheduledJobs
}
