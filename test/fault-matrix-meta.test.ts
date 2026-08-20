import { describe, expect, it } from 'vitest'
import { BASE_URL, FAULTS, MONITOR_ID } from './support/faults.js'
import { INVARIANTS, type Invariant, hosts, observe, violations } from './support/fault-harness.js'
import { type Integration, UNSAFE_INTEGRATION } from './support/integrations.js'

const LEAKY_INTEGRATION: Integration = {
  id: '__selftest__/leaves-bodies-open',
  exports: [],
  pings: 1,
  unsafe: true,
  invoke: async ({ fault, host }) => {
    const dispatch = fault.clientOptions.fetch

    if (dispatch !== undefined) {
      await dispatch(`${BASE_URL}/ping/${MONITOR_ID}`, { method: 'GET', headers: {} }).catch(
        () => undefined,
      )
    }

    return host()
  },
}

async function breakages(integration: Integration): Promise<Map<Invariant, string>> {
  const found = new Map<Invariant, string>()

  for (const fault of FAULTS) {
    for (const host of hosts()) {
      const observation = await observe(integration, fault, host)

      for (const invariant of violations(observation, host, MONITOR_ID)) {
        if (!found.has(invariant)) {
          found.set(invariant, `${fault.id} / job ${host.id}`)
        }
      }
    }
  }

  return found
}

describe('the negative control', () => {
  it('breaks every fail-open invariant the matrix asserts', async () => {
    const unsafe = await breakages(UNSAFE_INTEGRATION)
    const leaky = await breakages(LEAKY_INTEGRATION)
    const broken = new Set([...unsafe.keys(), ...leaky.keys()])

    process.stderr.write(
      `negative control — ${[...unsafe, ...leaky]
        .map(([invariant, where]) => `\n    ${invariant}: ${where}`)
        .join('')}\n`,
    )

    expect([...broken].sort()).toEqual([...INVARIANTS].sort())
  }, 60_000)
})
