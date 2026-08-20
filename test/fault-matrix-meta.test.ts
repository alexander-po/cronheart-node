import { describe, expect, it } from 'vitest'
import { BASE_URL, FAULTS, MONITOR_ID } from './support/faults.js'
import {
  type Host,
  INVARIANTS,
  type Invariant,
  type Observation,
  hosts,
  observe,
  violations,
} from './support/fault-harness.js'
import { type Integration, UNSAFE_INTEGRATION } from './support/integrations.js'

const SCREAMED_ID = `CRONHEART_${MONITOR_ID.toUpperCase().replaceAll('-', '_')}_UUID`

function observationOf(overrides: Partial<Observation>): Observation {
  return {
    returned: undefined,
    thrown: undefined,
    threw: false,
    settled: true,
    elapsedMs: 0,
    boundMs: 1000,
    unhandled: [],
    output: '',
    undrainedBodies: 0,
    stack: undefined,
    ...overrides,
  }
}

const quietHost: Host = {
  id: 'returns-a-value',
  throws: false,
  expected: undefined,
  call: () => undefined,
}

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

describe('the identifier rule', () => {
  it('fires on the id itself, on the variable name it is mangled into, and on a token', () => {
    const cases = [
      `about to check in for ${MONITOR_ID}`,
      `Set ${SCREAMED_ID} to resume monitoring`,
      'authorization: cmk_0123456789abcdef',
    ]

    for (const output of cases) {
      expect(violations(observationOf({ output }), quietHost, MONITOR_ID)).toContain(
        'no-identifier-in-the-output',
      )
    }
  })

  it('fires on an error the SDK put in the caller’s hands, not only on what it printed', () => {
    const observation = observationOf({
      threw: true,
      thrown: new Error(`the check-in for ${MONITOR_ID} failed`),
    })

    expect(violations(observation, quietHost, MONITOR_ID)).toContain(
      'no-identifier-in-the-output',
    )
  })

  it('stays quiet about the host’s own error, which the SDK must hand back unread', () => {
    const failure = new Error(`the job that pings ${MONITOR_ID} failed`)
    const host: Host = {
      id: 'throws',
      throws: true,
      expected: failure,
      call: () => {
        throw failure
      },
    }
    const observation = observationOf({ threw: true, thrown: failure, stack: failure.stack })

    expect(violations(observation, host, MONITOR_ID)).toEqual([])
  })
})

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
