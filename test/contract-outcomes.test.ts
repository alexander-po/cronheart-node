import { describe, expect, it } from 'vitest'
import { PING_OUTCOMES } from '../src/ping/outcome.js'
import { contract } from './support/server-model.js'

const stated = contract.vocabularies['ping.outcome']?.members ?? []
const statedMembers = new Set<string>(stated)
const exported = new Set<string>(PING_OUTCOMES)

describe('the outcome vocabulary', () => {
  it('is non-empty on both sides, so neither list can agree by being missing', () => {
    expect(stated.length).toBeGreaterThan(0)
    expect(PING_OUTCOMES.length).toBeGreaterThan(0)
  })

  it('states every outcome the SDK can return', () => {
    expect(PING_OUTCOMES.filter((outcome) => !statedMembers.has(outcome))).toEqual([])
  })

  it('states no outcome the SDK cannot return', () => {
    expect(stated.filter((outcome) => !exported.has(outcome))).toEqual([])
  })
})
