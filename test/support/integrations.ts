import { unsafelyMonitored } from '../../src/integrations/__selftest__.js'
import type { CheckInThunk, PingClient } from '../../src/ping/types.js'
import { CronheartConfigurationError } from '../../src/wiring/errors.js'
import { BASE_URL, type FaultInstance, MONITOR_ID } from './faults.js'

export interface InvocationContext {
  readonly client: PingClient
  readonly fault: FaultInstance
  readonly host: () => unknown
}

export interface Integration {
  readonly id: string
  readonly exports: readonly string[]
  readonly pings: number
  readonly unsafe: boolean
  invoke(context: InvocationContext): Promise<unknown>
}

export const INTEGRATIONS: readonly Integration[] = [
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
]

export const UNSAFE_INTEGRATION: Integration = {
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

export const REGISTRY: readonly Integration[] = [...INTEGRATIONS, UNSAFE_INTEGRATION]
