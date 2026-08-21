import type { Job, Processor, WorkerOptions } from 'bullmq'
import { unsafelyMonitored } from '../../src/integrations/__selftest__.js'
import {
  type BullMqMonitorOptions,
  monitored as monitoredByBullMq,
} from '../../src/integrations/bullmq.js'
import { monitored as monitoredByCron } from '../../src/integrations/cron.js'
import { monitored as monitoredByCroner } from '../../src/integrations/croner.js'
import { monitor as monitorNodeCronTask } from '../../src/integrations/node-cron.js'
import {
  CronheartModule,
  type NestMonitorOptions,
  type ScheduledJobs,
  monitorScheduledJobs,
} from '../../src/integrations/nestjs.js'
import { monitored as monitoredBySchedule } from '../../src/integrations/node-schedule.js'
import type { AdapterOptions } from '../../src/integrations/run.js'
import { fakeJob } from './bullmq-job.js'
import { fakeCronJob, fakeRegistry } from './nest-registry.js'
import { execution, fakeTask } from './node-cron-task.js'
import { unsafelyManaged } from '../../src/api/__selftest__.js'
import { createCronheartApi } from '../../src/api/client.js'
import { isCronheartApiError } from '../../src/api/errors.js'
import type { CronheartApi, CronheartApiOptions } from '../../src/api/types.js'
import type { CheckInThunk, PingClient } from '../../src/ping/types.js'
import { applySync } from '../../src/sync/apply.js'
import { planSync } from '../../src/sync/plan.js'
import { isSyncConfigurationError } from '../../src/sync/errors.js'
import { renderPlan, renderResult } from '../../src/sync/render.js'
import type { SyncPlan } from '../../src/sync/types.js'
import { CronheartConfigurationError } from '../../src/wiring/errors.js'
import { API_KEY, BASE_URL, BUDGET_MS, type FaultInstance, MONITOR_ID } from './faults.js'

export interface InvocationContext {
  readonly client: PingClient
  readonly fault: FaultInstance
  readonly host: () => unknown
  record(value: unknown): void
}

export interface EntryPoint {
  readonly id: string
  readonly exports: readonly string[]
  readonly pings: number
  readonly unsafe: boolean
  invoke(context: InvocationContext): Promise<unknown>
}

function managementOptions(fault: FaultInstance): CronheartApiOptions {
  return {
    apiKey: API_KEY,
    baseUrl: typeof fault.clientOptions.baseUrl === 'string' ? fault.clientOptions.baseUrl : BASE_URL,
    env: {},
    retries: 0,
    timeoutMs: BUDGET_MS,
    fetch: fault.clientOptions.fetch,
    signal: fault.clientOptions.signal,
  }
}

// The management client is the inverse of the check-in client: it is supposed to throw, so
// the case swallows exactly the type it promises and rethrows anything else. An escape that
// is not a branded error therefore breaks the same invariant a check-in would break, and
// everything it hands back is recorded so the leak rules read it too.
async function managed(
  context: InvocationContext,
  call: (api: CronheartApi) => Promise<unknown>,
): Promise<void> {
  let api: CronheartApi

  try {
    api = createCronheartApi(managementOptions(context.fault))
  } catch (error) {
    context.record(error)

    if (!isCronheartApiError(error)) {
      throw error
    }

    return
  }

  try {
    context.record(await call(api))
  } catch (error) {
    context.record(error)

    if (!isCronheartApiError(error)) {
      throw error
    }
  }
}

export const CHECK_IN_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: 'checkIn',
    exports: ['.#checkIn', '.#ping'],
    pings: 1,
    unsafe: false,
    invoke: async ({ client, fault, host }) => {
      await client.ping(fault.monitor, fault.pingOptions)

      return host()
    },
  },
  {
    id: 'withMonitor',
    exports: ['.#withMonitor'],
    pings: 2,
    unsafe: false,
    invoke: ({ client, fault, host }) => client.withMonitor(fault.monitor, host, fault.pingOptions),
  },
  {
    id: 'startRun',
    exports: ['.#startRun'],
    pings: 2,
    unsafe: false,
    invoke: async ({ client, fault, host }) => {
      const run = client.startRun(fault.monitor, fault.pingOptions)

      try {
        const value = await host()
        await run.success()

        return value
      } catch (error) {
        await run.fail(error)
        throw error
      }
    },
  },
  {
    id: 'checkInWith',
    exports: ['.#checkInWith'],
    pings: 1,
    unsafe: false,
    invoke: async ({ client, fault, host }) => {
      let beat: CheckInThunk | undefined

      try {
        beat = client.checkInWith(fault.monitor, fault.pingOptions)
      } catch (error) {
        if (!(error instanceof CronheartConfigurationError)) {
          throw error
        }
      }

      beat?.()
      const value = await host()
      await beat?.flush()

      return value
    },
  },
  {
    id: 'api.monitors.list',
    exports: ['./api#createCronheartApi'],
    pings: 1,
    unsafe: false,
    invoke: async (context) => {
      await managed(context, (api) => api.monitors.list())

      return context.host()
    },
  },
  // The one management case whose path carries the monitor identifier: without it the
  // no-identifier rule has nothing to fire on across this half of the surface.
  {
    id: 'api.monitors.get',
    exports: [],
    pings: 1,
    unsafe: false,
    invoke: async (context) => {
      await managed(context, (api) => api.monitors.get(MONITOR_ID))

      return context.host()
    },
  },
  {
    id: 'api.monitors.create',
    exports: [],
    pings: 1,
    unsafe: false,
    invoke: async (context) => {
      await managed(context, (api) =>
        api.monitors.create(
          { name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' },
          { idempotencyKey: 'a-key-the-caller-chose' },
        ),
      )

      return context.host()
    },
  },
]

// A plan built by hand rather than read back, so the write half of the reconciler is
// reachable under a transport that never answers — which is where a rejection nobody models
// or an identifier in a failure message would otherwise escape unseen.
const PLAN_TO_APPLY: SyncPlan = {
  rows: [
    {
      action: 'create',
      name: 'nightly-backup',
      alerts: [{ id: '7', kind: 'email', label: 'ops inbox' }],
      alertsNobody: false,
      suppression: undefined,
      request: { name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *', channelIds: ['7'] },
      idempotencyKey: `sync-${'0'.repeat(64)}`,
    },
    {
      action: 'orphan',
      name: 'retired',
      uuid: MONITOR_ID,
      alerts: [],
      alertsNobody: true,
      suppression: undefined,
    },
  ],
  counts: { create: 1, update: 0, unchanged: 0, orphan: 1, conflict: 0, refused: 0 },
  described: 1,
  onService: 1,
  silent: 1,
  drift: true,
  faults: false,
  scopeNotice: 'a notice',
}

// The reconciler is the management client's other consumer, so it inherits the same
// contract: everything it raises is branded, and nothing it hands back names the credential
// or the identifier. Everything it produces is recorded so the leak rules read it too.
async function reconciled(
  context: InvocationContext,
  run: (api: CronheartApi) => Promise<unknown>,
): Promise<void> {
  let api: CronheartApi

  try {
    api = createCronheartApi(managementOptions(context.fault))
  } catch (error) {
    context.record(error)

    if (!isCronheartApiError(error) && !isSyncConfigurationError(error)) {
      throw error
    }

    return
  }

  try {
    context.record(await run(api))
  } catch (error) {
    context.record(error)

    if (!isCronheartApiError(error) && !isSyncConfigurationError(error)) {
      throw error
    }
  }
}

export const SYNC_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: 'sync.planSync',
    exports: ['./sync#planSync'],
    pings: 1,
    unsafe: false,
    invoke: async (context) => {
      await reconciled(context, async (api) =>
        renderPlan(
          await planSync(api, [
            { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
          ]),
        ),
      )

      return context.host()
    },
  },
  {
    id: 'sync.applySync',
    exports: ['./sync#applySync'],
    pings: 1,
    unsafe: false,
    invoke: async (context) => {
      await reconciled(context, async (api) =>
        renderResult(
          await applySync(api, PLAN_TO_APPLY, { prune: { confirm: () => true } }),
        ),
      )

      return context.host()
    },
  },
]

export const UNSAFE_MANAGEMENT_ENTRY_POINT: EntryPoint = {
  id: '__selftest__/management',
  exports: [],
  pings: 1,
  unsafe: true,
  invoke: async (context) => {
    const value = await unsafelyManaged(managementOptions(context.fault))
    context.record(value)

    return context.host()
  },
}

export const UNSAFE_ENTRY_POINT: EntryPoint = {
  id: '__selftest__',
  exports: ['__selftest__#unsafelyMonitored'],
  pings: 1,
  unsafe: true,
  invoke: ({ fault, host }) =>
    unsafelyMonitored(
      { baseUrl: BASE_URL, monitorId: MONITOR_ID, fetch: fault.clientOptions.fetch },
      host,
    ),
}


// The adapters take their own options object, so the hostile-input axis reaches them the
// same way it reaches a check-in: by inheritance rather than by copying, because reading
// the fault's exploding accessors here would put the explosion in the harness's frame
// instead of the SDK's, and the case would then prove nothing about the SDK at all.
function adapterOptions(context: InvocationContext): AdapterOptions {
  const options = Object.create(context.fault.pingOptions) as AdapterOptions

  return Object.assign(options, { client: context.client })
}

// A refusal at wiring time is the documented behaviour, not an escape: the adapters resolve
// the monitor and check the schedule where the job is wired. What must still hold is that
// the host runs and its value or its error comes back untouched.
function wired<T>(build: () => T): T | undefined {
  try {
    return build()
  } catch (error) {
    if (!(error instanceof CronheartConfigurationError)) {
      throw error
    }

    return undefined
  }
}

const SCHEDULE = '0 3 * * *'

const QUEUED_JOB = 'nightly-digest'

const REGISTERED_JOB = 'nightlyDigest'

// Assigned onto the options object rather than spread into a new one, for the reason the
// note above gives: spreading would read the fault's exploding accessors here.
function mappedOptions<T>(context: InvocationContext, job: string): T {
  return Object.assign(adapterOptions(context), {
    jobs: { [job]: context.fault.monitor },
    report: () => {},
  }) as T
}

export const ADAPTER_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: 'croner.monitored',
    exports: ['./croner#monitored'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const args = wired(() =>
        monitoredByCroner(
          context.fault.monitor,
          SCHEDULE,
          {},
          context.host,
          adapterOptions(context),
        ),
      )

      if (args === undefined) {
        return context.host()
      }

      return args[2](undefined as never, undefined)
    },
  },
  {
    id: 'cron.monitored',
    exports: ['./cron#monitored'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const params = wired(() =>
        monitoredByCron(
          context.fault.monitor,
          { cronTime: SCHEDULE, onTick: context.host as () => unknown },
          adapterOptions(context),
        ),
      )

      if (params === undefined) {
        return context.host()
      }

      return (params.onTick as (this: unknown) => Promise<unknown>).call(undefined)
    },
  },
  {
    id: 'node-schedule.monitored',
    exports: ['./node-schedule#monitored'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const args = wired(() =>
        monitoredBySchedule(
          context.fault.monitor,
          SCHEDULE,
          context.host,
          adapterOptions(context),
        ),
      )

      if (args === undefined) {
        return context.host()
      }

      return args[2](new Date())
    },
  },
  // The one adapter that never runs the host: it attaches to node-cron's events, so the
  // case drives the events around a host it calls itself, which is exactly the sequence a
  // task emits — and the failure event hands the host's own error to the SDK to describe.
  {
    id: 'node-cron.monitor',
    exports: ['./node-cron#monitor'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const task = fakeTask(SCHEDULE)
      const attached = wired(() =>
        monitorNodeCronTask(task, context.fault.monitor, adapterOptions(context)),
      )

      if (attached === undefined) {
        return context.host()
      }

      task.emit('execution:started', execution('one'))

      try {
        const value = await context.host()
        task.emit('execution:finished', execution('one', { result: value }))
        await attached.flush(BUDGET_MS * 2)

        return value
      } catch (error) {
        task.emit('execution:failed', execution('one', { error }))
        await attached.flush(BUDGET_MS * 2)
        throw error
      }
    },
  },
]

export const QUEUE_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: 'bullmq.monitored',
    exports: ['./bullmq#monitored'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const args = wired(() =>
        monitoredByBullMq(
          'digests',
          {} as WorkerOptions,
          (() => Promise.resolve(context.host())) as Processor,
          mappedOptions<BullMqMonitorOptions>(context, QUEUED_JOB),
        ),
      )

      if (args === undefined) {
        return context.host()
      }

      return (args[1] as unknown as (job: Job) => Promise<unknown>)(fakeJob())
    },
  },
  // The nestjs adapter never runs the host itself either: it replaces the callback the
  // scheduler holds, so the case fires the job the way the scheduler fires it.
  {
    id: 'nestjs.monitorScheduledJobs',
    exports: ['./nestjs#monitorScheduledJobs'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const job = fakeCronJob(SCHEDULE, context.host)
      const attached = wired(() =>
        monitorScheduledJobs(
          fakeRegistry({ [REGISTERED_JOB]: job }),
          mappedOptions<NestMonitorOptions>(context, REGISTERED_JOB),
        ),
      )

      if (attached === undefined) {
        return context.host()
      }

      try {
        return await job.fire()
      } finally {
        await attached.flush(BUDGET_MS * 2)
      }
    },
  },
  {
    id: 'nestjs.CronheartModule',
    exports: ['./nestjs#CronheartModule'],
    pings: 2,
    unsafe: false,
    invoke: async (context) => {
      const job = fakeCronJob(SCHEDULE, context.host)
      const registry = fakeRegistry({ [REGISTERED_JOB]: job })
      const dynamic = wired(() =>
        CronheartModule.forRoot(
          Object.assign(mappedOptions<NestMonitorOptions>(context, REGISTERED_JOB), {
            registry: class StandInRegistry {} as never,
          }),
        ),
      )
      const provider = (dynamic?.providers ?? [])[0] as unknown as
        | {
            useFactory(held: ScheduledJobs): {
              onApplicationBootstrap(): void
              onApplicationShutdown(): Promise<void>
            }
          }
        | undefined

      if (provider === undefined) {
        return context.host()
      }

      const instance = provider.useFactory(registry)
      wired(() => {
        instance.onApplicationBootstrap()
      })

      try {
        return await job.fire()
      } finally {
        await instance.onApplicationShutdown()
      }
    },
  },
]

export const ENTRY_POINTS: readonly EntryPoint[] = [
  ...CHECK_IN_ENTRY_POINTS,
  ...SYNC_ENTRY_POINTS,
  ...ADAPTER_ENTRY_POINTS,
  ...QUEUE_ENTRY_POINTS,
]

export const REGISTRY: readonly EntryPoint[] = [
  ...ENTRY_POINTS,
  UNSAFE_ENTRY_POINT,
  UNSAFE_MANAGEMENT_ENTRY_POINT,
]
