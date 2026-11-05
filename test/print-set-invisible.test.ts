import { describe, expect, it } from 'vitest'
import { withForbiddenRemoved, withForbiddenSpelledOut } from '../src/print-set.js'

const EMOJI_JOINERS = new Set([0x200c, 0x200d, 0xfe0e, 0xfe0f])

describe('the invisible characters a name is read without', () => {
  it('are exactly the ranges the print set spells out, and the joiners emoji are written with', () => {
    const differing: string[] = []

    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const character = String.fromCodePoint(codePoint)
      const removed = withForbiddenRemoved(character) === ''
      const listed = withForbiddenSpelledOut(character) !== character || EMOJI_JOINERS.has(codePoint)

      if (removed !== listed) {
        differing.push(codePoint.toString(16))
      }
    }

    expect(differing).toEqual([])
  })
})
