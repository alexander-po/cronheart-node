import { describe, expect, it } from 'vitest'
import { createStderrTail } from '../src/cli/stderr-tail.js'

const encoder = new TextEncoder()

const REPLACEMENT = '�'

const SECRET = `cmk_${'A'.repeat(39)}`

// The same length and shape, matching nothing: it is the control that proves an offset the
// secret vanished from is one material actually reaches the wire at, rather than one the
// budget had already thrown away.
const HARMLESS = `qqq_${'B'.repeat(39)}`

const BUDGET = 512

let ceiling: number | undefined

// Found by watching the ring rather than by importing the constant it is tuned by, so the
// test goes on asking the question it means to ask if that tuning ever changes.
function ceilingOf(budget: number): number {
  if (ceiling !== undefined) {
    return ceiling
  }

  const probe = createStderrTail(budget)
  const one = encoder.encode('.')
  let held = 0

  for (;;) {
    probe.push(one)

    if (probe.bytes <= held) {
      ceiling = held

      return held
    }

    held = probe.bytes
  }
}

function push(tail: { push(chunk: Uint8Array): void }, text: string, chunkBytes: number): void {
  const bytes = encoder.encode(text)

  for (let at = 0; at < bytes.length; at += chunkBytes) {
    tail.push(bytes.subarray(at, at + chunkBytes))
  }
}

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

  it('holds a bounded amount however much is written through it, and sends the budget', () => {
    const tail = createStderrTail(32)

    for (let round = 0; round < 50_000; round += 1) {
      tail.push(encoder.encode('0123456789'))
    }

    expect(tail.bytes).toBeLessThan(32 + 16_384)
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

// Every cut this ring makes is a place a secret could lose the anchor its pattern keys on and
// survive as plain material. There are three: the edge between two writes, the eviction that
// keeps the ring bounded, and the byte budget's own cut. The excerpt is redacted before each
// of them, so all three can only ever split [redacted] in half.
describe('a secret straddling a boundary the ring introduces', () => {
  it.each([1, 2, 3, 5, 8, 13, 64])('survives none of it when written %i bytes at a time', (chunkBytes) => {
    const tail = createStderrTail(BUDGET)

    push(tail, `opening line\n${SECRET}\nclosing line\n`, chunkBytes)

    const out = tail.text()

    expect(out).toContain('[redacted]')
    expect(out).toContain('closing line')
    expect(out).not.toMatch(/A{8,}/)
  })

  it.each(Array.from({ length: 42 }, (_unused, at) => at + 1))(
    'survives none of it when the write splits it after byte %i',
    (splitAt) => {
      const tail = createStderrTail(BUDGET)

      tail.push(encoder.encode(`opening\n${SECRET.slice(0, splitAt)}`))
      tail.push(encoder.encode(`${SECRET.slice(splitAt)}\nclosing\n`))

      const out = tail.text()

      expect(out).toContain('[redacted]')
      expect(out).not.toMatch(/A{8,}/)
    },
  )

  // The budget keeps the last BUDGET bytes, so a payload this far from the end is one the
  // cut lands inside: at into = 4 the cut falls immediately after cmk_, which is the
  // reported reproduction — the anchor outside the excerpt, the token still in it.
  it.each(Array.from({ length: SECRET.length }, (_unused, into) => into))(
    'survives none of it when the byte budget cuts %i bytes into it',
    (into) => {
      const trailing = BUDGET - (SECRET.length - into) - 1
      const secretRun = createStderrTail(BUDGET)
      const controlRun = createStderrTail(BUDGET)

      push(secretRun, `head\n${SECRET}\n${'.'.repeat(trailing)}`, 7)
      push(controlRun, `head\n${HARMLESS}\n${'.'.repeat(trailing)}`, 7)

      expect(controlRun.text()).toContain(HARMLESS.slice(into))
      expect(secretRun.text()).not.toContain(SECRET.slice(into))
      expect(secretRun.text()).not.toMatch(/A{8,}/)
    },
  )

  it.each(Array.from({ length: 20 }, (_unused, at) => at * 2 + 1))(
    'survives none of it when the ring evicts %i bytes into it',
    (into) => {
      const ceiling = ceilingOf(BUDGET)
      const tail = createStderrTail(BUDGET)

      push(tail, '.'.repeat(ceiling - into), 997)
      push(tail, `${SECRET}\nclosing\n`, 1)

      const out = tail.text()

      expect(out).toContain('[redacted]')
      expect(out).toContain('closing')
      expect(out).not.toMatch(/A{8,}/)
    },
  )

  it('applies a caller pattern at those same boundaries, not only the built-in ones', () => {
    const tail = createStderrTail(BUDGET, [/INTERNAL-[0-9]{6}/g])

    push(tail, 'head\nINTERNAL-424242\nclosing\n', 1)

    expect(tail.text()).toContain('[redacted]')
    expect(tail.text()).not.toContain('424242')
  })
})
