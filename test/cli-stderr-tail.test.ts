import { describe, expect, it } from 'vitest'
import { createStderrTail } from '../src/cli/stderr-tail.js'

const encoder = new TextEncoder()

const REPLACEMENT = '�'

function feed(budget: number, text: string, chunkBytes: number): string {
  const tail = createStderrTail(budget)
  const bytes = encoder.encode(text)

  for (let at = 0; at < bytes.length; at += chunkBytes) {
    tail.push(bytes.subarray(at, at + chunkBytes))
  }

  return tail.text()
}

describe('the stderr ring buffer', () => {
  it('returns everything it was given while it fits', () => {
    expect(feed(64, 'short line\n', 3)).toBe('short line\n')
  })

  it('keeps the end rather than the beginning', () => {
    expect(feed(5, 'abcdefghij', 4)).toBe('fghij')
  })

  it('never turns a character split across two writes into a replacement character', () => {
    const text = '€'.repeat(20)
    const kept = feed(1000, text, 7)

    expect(kept).toBe(text)
    expect(kept).not.toContain(REPLACEMENT)
  })

  it('drops the partial character the budget cut through instead of decoding it', () => {
    const kept = feed(10, '€'.repeat(20), 7)

    expect(kept).not.toContain(REPLACEMENT)
    expect(kept).toBe('€€€')
    expect(encoder.encode(kept)).toHaveLength(9)
  })

  it('holds no more than the budget however much is written through it', () => {
    const tail = createStderrTail(32)

    for (let round = 0; round < 500; round += 1) {
      tail.push(encoder.encode('0123456789'))
    }

    expect(tail.bytes).toBe(32)
    expect(tail.text()).toBe('89012345678901234567890123456789')
  })

  it('keeps nothing at all when the budget is zero', () => {
    const tail = createStderrTail(0)
    tail.push(encoder.encode('anything'))

    expect(tail.bytes).toBe(0)
    expect(tail.text()).toBe('')
  })

  it('trims a single write that is larger than the whole budget', () => {
    expect(feed(4, 'abcdefghij', 100)).toBe('ghij')
  })
})
