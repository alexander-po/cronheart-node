import { describe, expect, it } from 'vitest'
import { PING_OUTCOMES } from '../src/ping/outcome.js'
import { contract } from './support/server-model.js'

// The two extras are the SDK's own off switches: nothing was sent, and the reason is
// a configuration one. The contract's vocabulary predates them. Adding them there is
// an `added` on a closed read vocabulary, which its own classification table calls
// breaking-readers and therefore a major bump — a decision that belongs with whoever
// owns the contract, not with this SDK. Until then the divergence is pinned here so
// it cannot widen unnoticed.
const OFF_SWITCH_OUTCOMES = ['suppressed', 'disabled']

describe('the outcome vocabulary', () => {
  it('is the contract vocabulary plus exactly the two off-switch outcomes', () => {
    const stated = contract.vocabularies['ping.outcome']?.members ?? []

    expect(stated.length).toBeGreaterThan(0)
    expect([...PING_OUTCOMES].sort()).toEqual([...stated, ...OFF_SWITCH_OUTCOMES].sort())
  })

  it('describes the members the contract does state as the ping response table does', () => {
    const stated = new Set(contract.vocabularies['ping.outcome']?.members ?? [])

    expect(PING_OUTCOMES.filter((outcome) => !stated.has(outcome))).toEqual(OFF_SWITCH_OUTCOMES)
  })
})
