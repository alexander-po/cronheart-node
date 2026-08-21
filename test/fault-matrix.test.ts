import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { ENTRY_POINTS, REGISTRY } from './support/entry-points.js'
import { API_KEY, FAULTS, MONITOR_ID } from './support/faults.js'
import { hosts, observe, violations } from './support/fault-harness.js'
import { callablesIn } from './support/surface.js'
import { HOSTILE_INPUTS, hostileHosts } from './support/hostile.js'

const repoRoot = new URL('../', import.meta.url)

const exportsMap = (
  JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as {
    exports: Readonly<Record<string, unknown>>
  }
).exports

// Recorded rather than inferred: a callable on the published surface is either in the
// matrix or carries a reason here, and a reason that no longer names anything fails too.
const NEEDS_NO_CASE: Readonly<Record<string, string>> = {
  '.#createPingClient': 'a factory — the client it hands back is reflected in its own right',
  './testing#createPingRecorder': 'a test double for consumers, not a check-in path',
  './testing#clearWarnings':
    'a test helper for consumers — it resets a warning ledger, it sends nothing',
  '.#userAgent': 'builds a string',
  './api#userAgent': 'builds a string',
  '.#flush': 'takes a deadline, not a callable',
  '.#start': 'a bare check-in — the bracketing entry points are the ones handed a callable',
  '.#success': 'a bare check-in — the bracketing entry points are the ones handed a callable',
  '.#fail': 'a bare check-in — the bracketing entry points are the ones handed a callable',
  '.#monitors.define': 'wiring-time registration',
  '.#monitors.resolve': 'wiring-time resolution',
  '.#monitors.has': 'wiring-time lookup',
  '.#CronheartConfigurationError': 'an error class',
  '.#InvalidActionError': 'an error class',
  '.#InvalidBaseUrlError': 'an error class',
  '.#InvalidMonitorIdError': 'an error class',
  '.#UnknownMonitorError': 'an error class',
  './api#isCronheartApiError': 'a brand check over a value the caller already holds',
  './api#CronheartApiError': 'an error class',
  './api#ApiResponseError': 'an error class',
  './api#ApiAuthenticationError': 'an error class',
  './api#ApiChannelDeliveryError': 'an error class',
  './api#ApiConfigurationError': 'an error class',
  './api#ApiConflictError': 'an error class',
  './api#ApiForbiddenError': 'an error class',
  './api#ApiHydrationError': 'an error class',
  './api#ApiInvalidRequestError': 'an error class',
  './api#ApiNotFoundError': 'an error class',
  './api#ApiPlanRestrictionError': 'an error class',
  './api#ApiRateLimitError': 'an error class',
  './api#ApiTransportError': 'an error class',
  './api#ApiUnexpectedResponseError': 'an error class',
  './api#ApiValidationError': 'an error class',
  './sync#SyncConfigurationError': 'an error class',
  './sync#isSyncConfigurationError': 'a brand check over a value the caller already holds',
  './sync#defineMonitors':
    'wiring-time validation — it reads a configuration, before any transport exists',
  './sync#renderPlan': 'formats a value the caller already holds',
  './sync#renderResult': 'formats a value the caller already holds',
  './sync#envLinesFor':
    'the one output that carries monitor identifiers, which is the whole of what it is for',
  './croner#CronheartConfigurationError': 'an error class',
  './croner#InvalidScheduleError': 'an error class',
  './croner#InvalidTimezoneError': 'an error class',
  './croner#UnknownMonitorError': 'an error class',
  './cron#CronheartConfigurationError': 'an error class',
  './cron#InvalidScheduleError': 'an error class',
  './cron#InvalidTimezoneError': 'an error class',
  './cron#UnknownMonitorError': 'an error class',
  './node-cron#CronheartConfigurationError': 'an error class',
  './node-cron#InvalidScheduleError': 'an error class',
  './node-cron#InvalidTimezoneError': 'an error class',
  './node-cron#UnknownMonitorError': 'an error class',
  './node-schedule#CronheartConfigurationError': 'an error class',
  './node-schedule#InvalidScheduleError': 'an error class',
  './node-schedule#InvalidTimezoneError': 'an error class',
  './node-schedule#UnknownMonitorError': 'an error class',
  './bullmq#CronheartConfigurationError': 'an error class',
  './bullmq#InvalidScheduleError': 'an error class',
  './bullmq#InvalidTimezoneError': 'an error class',
  './bullmq#UnknownMonitorError': 'an error class',
  './nestjs#CronheartConfigurationError': 'an error class',
  './nestjs#InvalidScheduleError': 'an error class',
  './nestjs#InvalidTimezoneError': 'an error class',
  './nestjs#UnknownMonitorError': 'an error class',
}

const SECRETS = { monitorId: MONITOR_ID, apiKey: API_KEY }

// Qualified by the subpath it is published under, not by its bare name: four adapters
// export a function called monitored, and a bare-name surface would collapse them into one
// key — registering any single adapter would then satisfy the guard for all four.
function under(subpath: string, names: readonly string[]): string[] {
  return names.map((name) => `${subpath}#${name}`)
}

async function publishedSurface(): Promise<string[]> {
  const found: string[] = []

  for (const [subpath, target] of Object.entries(exportsMap)) {
    const file = (target as { import?: { default?: unknown } }).import?.default

    if (typeof file !== 'string') {
      continue
    }

    found.push(...under(subpath, callablesIn((await import(new URL(file, repoRoot).href)) as object)))
  }

  const index = (await import(new URL('dist/index.mjs', repoRoot).href)) as {
    createPingClient: (options: { env: Record<string, string> }) => object
  }
  const selftest = await import('../src/integrations/__selftest__.js')

  return [
    ...found,
    ...under('.', callablesIn(index.createPingClient({ env: {} }))),
    ...under('__selftest__', callablesIn(selftest)),
  ]
}

const PLANNED_CASES =
  ENTRY_POINTS.length *
  (FAULTS.length * hosts().length +
    HOSTILE_INPUTS.length * (hosts().length + hostileHosts().length))

let executedCases = 0

describe('the fault matrix registry', () => {
  it('is derived from the built surface, so a new entry point of any shape is seen', async () => {
    const surface = [...new Set(await publishedSurface())]
    const registered = new Set(REGISTRY.flatMap((entryPoint) => entryPoint.exports))

    expect(surface.length).toBeGreaterThan(0)
    expect(
      surface.filter((name) => !registered.has(name) && !Object.hasOwn(NEEDS_NO_CASE, name)),
    ).toEqual([])
    expect([...registered].filter((name) => !surface.includes(name))).toEqual([])
    expect(Object.keys(NEEDS_NO_CASE).filter((name) => !surface.includes(name))).toEqual([])
  })
})

describe.each(ENTRY_POINTS)('$id survives', (entryPoint) => {
  describe.each(FAULTS)('$id', (fault) => {
    it.each(hosts())('while the job $id', async (host) => {
      executedCases += 1

      const observation = await observe(entryPoint, fault, host)

      expect(violations(observation, host, SECRETS)).toEqual([])
    })
  })
})

describe.each(ENTRY_POINTS)('$id survives what the host hands in', (entryPoint) => {
  describe.each(HOSTILE_INPUTS)('$id', (fault) => {
    it.each([...hosts(), ...hostileHosts()])('while the job $id', async (host) => {
      executedCases += 1

      const observation = await observe(entryPoint, fault, host)

      expect(violations(observation, host, SECRETS)).toEqual([])
    })
  })
})

// The coverage claim is the count of cases that ran, not the product of the axis lengths:
// an axis that empties multiplies out to a number nothing has to satisfy.
afterAll(() => {
  process.stderr.write(
    `fault matrix — ${executedCases} case(s) over ${ENTRY_POINTS.length} entry point(s), ${FAULTS.length} fault(s), ${HOSTILE_INPUTS.length} hostile input(s)\n`,
  )

  expect(executedCases).toBe(PLANNED_CASES)
  expect(executedCases).toBeGreaterThan(200)
})
