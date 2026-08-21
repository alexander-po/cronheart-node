import { describe, expect, it } from 'vitest'
import { PING_ACTIONS, PING_EMITTABLE_ACTIONS } from '../src/index.js'
import { type PingAction, segmentFor } from '../src/ping/action.js'
import { InvalidActionError } from '../src/wiring/errors.js'
import { pingPath } from '../src/wiring/validate.js'

describe('both action vocabularies are published, because they are not the same set', () => {
  it('separates every action the SDK sends from the subset that becomes a URL segment', () => {
    expect([...PING_ACTIONS]).toContain('heartbeat')
    expect([...PING_EMITTABLE_ACTIONS]).not.toContain('heartbeat')
    expect(PING_EMITTABLE_ACTIONS.length).toBe(PING_ACTIONS.length - 1)
    expect(PING_EMITTABLE_ACTIONS.filter((action) => !PING_ACTIONS.includes(action))).toEqual([])
  })
})

describe('the action segment', () => {
  it('is absent for a heartbeat and is the action itself for everything this SDK emits', () => {
    expect(segmentFor('heartbeat')).toBeNull()
    expect(['start', 'success', 'fail'].map((action) => segmentFor(action as PingAction))).toEqual([
      'start',
      'success',
      'fail',
    ])
  })

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'is not inherited from a prototype for %s',
    (action) => {
      expect(segmentFor(action as PingAction)).toBeUndefined()
    },
  )

  it('is undefined for an action nothing defines, rather than a segment', () => {
    expect(segmentFor('succes' as PingAction)).toBeUndefined()
  })
})

describe('the ping path', () => {
  it('is empty for a heartbeat and carries the literal segment otherwise', () => {
    expect(pingPath('heartbeat')).toBe('')
    expect(pingPath('start')).toBe('/start')
    expect(pingPath('success')).toBe('/success')
    expect(pingPath('fail')).toBe('/fail')
  })

  it.each(['constructor', 'toString', 'succes', ''])(
    'refuses to build a path for %s rather than letting the server read it as a heartbeat',
    (action) => {
      expect(() => pingPath(action as PingAction)).toThrow(InvalidActionError)
    },
  )
})
