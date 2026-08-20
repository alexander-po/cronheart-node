import { describe, expect, it } from 'vitest'
import { API_KEY, BASE_URL, FAULTS, MONITOR_ID } from './support/faults.js'
import {
  type Host,
  INVARIANTS,
  type Invariant,
  type Observation,
  hosts,
  observe,
  violations,
} from './support/fault-harness.js'
import {
  type EntryPoint,
  UNSAFE_ENTRY_POINT,
  UNSAFE_MANAGEMENT_ENTRY_POINT,
} from './support/entry-points.js'

const SCREAMED_ID = `CRONHEART_${MONITOR_ID.toUpperCase().replaceAll('-', '_')}_UUID`

const SECRETS = { monitorId: MONITOR_ID, apiKey: API_KEY }

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
    recorded: [],
    ...overrides,
  }
}

const quietHost: Host = {
  id: 'returns-a-value',
  throws: false,
  expected: undefined,
  call: () => undefined,
}

const LEAKY_ENTRY_POINT: EntryPoint = {
  id: '__selftest__/leaves-bodies-open',
  exports: [],
  pings: 1,
  unsafe: true,
  invoke: async ({ fault, host }) => {
    const transport = fault.clientOptions.fetch

    if (transport !== undefined) {
      await transport(`${BASE_URL}/ping/${MONITOR_ID}`, {
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
      }).catch(() => undefined)
    }

    return host()
  },
}

async function breakages(entryPoint: EntryPoint): Promise<Map<Invariant, string>> {
  const found = new Map<Invariant, string>()

  for (const fault of FAULTS) {
    for (const host of hosts()) {
      const observation = await observe(entryPoint, fault, host)

      for (const invariant of violations(observation, host, SECRETS)) {
        if (!found.has(invariant)) {
          found.set(invariant, `${fault.id} / job ${host.id}`)
        }
      }
    }
  }

  return found
}

describe('the identifier rule', () => {
  it('fires on the id itself and on the variable name it is mangled into', () => {
    const cases = [
      `about to check in for ${MONITOR_ID}`,
      `Set ${SCREAMED_ID} to resume monitoring`,
    ]

    for (const output of cases) {
      expect(violations(observationOf({ output }), quietHost, SECRETS)).toContain(
        'no-identifier-in-the-output',
      )
    }
  })

  it('fires on an error the SDK put in the caller’s hands, not only on what it printed', () => {
    const observation = observationOf({
      threw: true,
      thrown: new Error(`the check-in for ${MONITOR_ID} failed`),
    })

    expect(violations(observation, quietHost, SECRETS)).toContain('no-identifier-in-the-output')
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

    expect(violations(observation, host, SECRETS)).toEqual([])
  })
})

describe('the credential rule', () => {
  it('fires on the key itself, on anything else key-shaped, and through every surface', () => {
    const surfaces = [
      observationOf({ output: `sending Authorization: Bearer ${API_KEY}` }),
      observationOf({ output: 'authorization: cmk_0123456789abcdef' }),
      observationOf({ threw: true, thrown: new Error(`bearer ${API_KEY} was refused`) }),
      observationOf({ recorded: [new Error(`bearer ${API_KEY} was refused`)] }),
      observationOf({ recorded: [{ headers: { authorization: `Bearer ${API_KEY}` } }] }),
      observationOf({
        recorded: [new Error('refused', { cause: new Error(`bearer ${API_KEY}`) })],
      }),
      observationOf({ recorded: [{ toJSON: () => ({ key: API_KEY }) }] }),
    ]

    for (const observation of surfaces) {
      expect(violations(observation, quietHost, SECRETS)).toContain(
        'no-credential-in-the-output',
      )
    }
  })

  it('stays quiet when nothing key-shaped was written, so it is not true of everything', () => {
    const observation = observationOf({
      output: 'GET /api/v1/monitors answered 402',
      recorded: [new Error('The REST API needs the Starter plan or above (HTTP 402).')],
    })

    expect(violations(observation, quietHost, SECRETS)).toEqual([])
  })
})

describe('the negative control', () => {
  it('breaks every fail-open invariant the matrix asserts', async () => {
    const unsafe = await breakages(UNSAFE_ENTRY_POINT)
    const leaky = await breakages(LEAKY_ENTRY_POINT)
    const managed = await breakages(UNSAFE_MANAGEMENT_ENTRY_POINT)
    const broken = new Set([...unsafe.keys(), ...leaky.keys(), ...managed.keys()])

    process.stderr.write(
      `negative control — ${[...unsafe, ...leaky, ...managed]
        .map(([invariant, where]) => `\n    ${invariant}: ${where}`)
        .join('')}\n`,
    )

    expect([...broken].sort()).toEqual([...INVARIANTS].sort())
  }, 120_000)
})
