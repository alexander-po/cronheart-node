import { unsafelyMonitored } from '../../src/integrations/__selftest__.js'
import { unsafelyManaged } from '../../src/api/__selftest__.js'
import { createCronheartApi } from '../../src/api/client.js'
import { isCronheartApiError } from '../../src/api/errors.js'
import type { CronheartApi, CronheartApiOptions } from '../../src/api/types.js'
import type { CheckInThunk, PingClient } from '../../src/ping/types.js'
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

export const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    id: 'checkIn',
    exports: ['checkIn', 'ping'],
    pings: 1,
    unsafe: false,
    invoke: async ({ client, fault, host }) => {
      await client.ping(fault.monitor, fault.pingOptions)

      return host()
    },
  },
  {
    id: 'withMonitor',
    exports: ['withMonitor'],
    pings: 2,
    unsafe: false,
    invoke: ({ client, fault, host }) => client.withMonitor(fault.monitor, host, fault.pingOptions),
  },
  {
    id: 'startRun',
    exports: ['startRun'],
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
    exports: ['checkInWith'],
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
    exports: ['createCronheartApi'],
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
  exports: ['unsafelyMonitored'],
  pings: 1,
  unsafe: true,
  invoke: ({ fault, host }) =>
    unsafelyMonitored(
      { baseUrl: BASE_URL, monitorId: MONITOR_ID, fetch: fault.clientOptions.fetch },
      host,
    ),
}

export const REGISTRY: readonly EntryPoint[] = [
  ...ENTRY_POINTS,
  UNSAFE_ENTRY_POINT,
  UNSAFE_MANAGEMENT_ENTRY_POINT,
]
