import { describe, expect, it } from 'vitest'
import { type Adapter, type VectorCase, runCase } from './support/vectors.js'

class Sentinel extends Error {}

const adapter: Adapter = {
  subjects: {
    known: (input) => input,
    throws: () => {
      throw new Sentinel('sentinel')
    },
  },
  errorClasses: { Sentinel },
}

function caseOf(overrides: Partial<VectorCase>): VectorCase {
  return {
    id: 'synthetic',
    subject: 'known',
    input: { value: 1 },
    expect: [{ predicate: 'equals', path: '/value', value: 1 }],
    ...overrides,
  }
}

describe('the vector runner cannot be vacuously green', () => {
  it('fails on a predicate it does not implement', async () => {
    const outcome = await runCase(
      caseOf({ expect: [{ predicate: 'isCloseTo', path: '/value', value: 1 }] }),
      undefined,
      adapter,
    )

    expect(outcome.executed).toBe(true)
    expect(outcome.failures).toEqual(['unknown predicate "isCloseTo"'])
  })

  it('fails on a subject it has not registered', async () => {
    const outcome = await runCase(caseOf({ subject: 'body.shred' }), undefined, adapter)

    expect(outcome.failures).toEqual([
      'unknown subject "body.shred" and the case is not optional',
    ])
  })

  it('skips an unregistered subject only when the case opts in', async () => {
    const outcome = await runCase(
      caseOf({ subject: 'body.shred', optional: true }),
      undefined,
      adapter,
    )

    expect(outcome).toEqual({ executed: false, failures: [] })
  })

  it('fails a case that asserts nothing', async () => {
    const outcome = await runCase(caseOf({ expect: [] }), undefined, adapter)

    expect(outcome.failures).toEqual(['a case must carry at least one assertion'])
  })

  it('reports a value mismatch rather than swallowing it', async () => {
    const outcome = await runCase(
      caseOf({ expect: [{ predicate: 'equals', path: '/value', value: 2 }] }),
      undefined,
      adapter,
    )

    expect(outcome.failures).toEqual(['at /value: expected 2, got 1'])
  })

  it('distinguishes a missing key from a null value', async () => {
    const outcome = await runCase(
      caseOf({ expect: [{ predicate: 'equals', path: '/absent', value: null }] }),
      undefined,
      adapter,
    )

    expect(outcome.failures).toEqual(['at /absent: expected null, got undefined'])
  })

  it('measures byteLength in UTF-8 bytes, not code units', async () => {
    const outcome = await runCase(
      caseOf({
        input: { value: '😀' },
        expect: [{ predicate: 'byteLength', path: '/value', value: 2 }],
      }),
      undefined,
      adapter,
    )

    expect(outcome.failures).toEqual(['expected 2 UTF-8 bytes, got 4'])
  })

  it('holds a subject that throws to the class the case names', async () => {
    const matched = await runCase(
      caseOf({
        subject: 'throws',
        expect: [{ predicate: 'rejects' }, { predicate: 'isErrorClass', value: 'Sentinel' }],
      }),
      undefined,
      adapter,
    )
    const unmapped = await runCase(
      caseOf({ subject: 'throws', expect: [{ predicate: 'isErrorClass', value: 'Other' }] }),
      undefined,
      adapter,
    )

    expect(matched.failures).toEqual([])
    expect(unmapped.failures).toEqual([
      'no local class is mapped to contract error class "Other"',
    ])
  })

  it('fails throwsNothing when the subject throws', async () => {
    const outcome = await runCase(
      caseOf({ subject: 'throws', expect: [{ predicate: 'throwsNothing' }] }),
      undefined,
      adapter,
    )

    expect(outcome.failures).toEqual(['expected no throw, got Error: sentinel'])
  })
})
