import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { ENTRY_POINTS, REGISTRY } from './support/entry-points.js'
import { FAULTS, MONITOR_ID } from './support/faults.js'
import { hosts, observe, violations } from './support/fault-harness.js'
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
  createPingClient: 'a factory — the client it hands back is reflected in its own right',
  createPingRecorder: 'a test double for consumers, not a check-in path',
  clearWarnings: 'a test helper for consumers — it resets a warning ledger, it sends nothing',
  userAgent: 'builds a string',
  flush: 'takes a deadline, not a callable',
  start: 'a bare check-in — the bracketing entry points are the ones handed a callable',
  success: 'a bare check-in — the bracketing entry points are the ones handed a callable',
  fail: 'a bare check-in — the bracketing entry points are the ones handed a callable',
  'monitors.define': 'wiring-time registration',
  'monitors.resolve': 'wiring-time resolution',
  'monitors.has': 'wiring-time lookup',
  CronheartConfigurationError: 'an error class',
  InvalidActionError: 'an error class',
  InvalidBaseUrlError: 'an error class',
  InvalidMonitorIdError: 'an error class',
  UnknownMonitorError: 'an error class',
}

function callablesIn(namespace: object): string[] {
  return Object.entries(namespace).flatMap(([name, value]: [string, unknown]) => {
    if (typeof value === 'function') {
      return [name]
    }

    if (value === null || typeof value !== 'object') {
      return []
    }

    return Object.entries(value)
      .filter(([, member]: [string, unknown]) => typeof member === 'function')
      .map(([member]) => `${name}.${member}`)
  })
}

async function publishedSurface(): Promise<string[]> {
  const files = Object.values(exportsMap)
    .map((target) => (target as { import?: { default?: unknown } }).import?.default)
    .filter((file): file is string => typeof file === 'string')
  const found: string[] = []

  for (const file of files) {
    found.push(...callablesIn((await import(new URL(file, repoRoot).href)) as object))
  }

  const index = (await import(new URL('dist/index.mjs', repoRoot).href)) as {
    createPingClient: (options: { env: Record<string, string> }) => object
  }
  const selftest = await import('../src/integrations/__selftest__.js')

  return [...found, ...callablesIn(index.createPingClient({ env: {} })), ...callablesIn(selftest)]
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

      expect(violations(observation, host, MONITOR_ID)).toEqual([])
    })
  })
})

describe.each(ENTRY_POINTS)('$id survives what the host hands in', (entryPoint) => {
  describe.each(HOSTILE_INPUTS)('$id', (fault) => {
    it.each([...hosts(), ...hostileHosts()])('while the job $id', async (host) => {
      executedCases += 1

      const observation = await observe(entryPoint, fault, host)

      expect(violations(observation, host, MONITOR_ID)).toEqual([])
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
