import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { disagreements, matches, parseRuleTable } from '../contract/classify.mjs'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { COMPARED_POINTERS } from '../contract/drift.mjs'

const RULES = readFileSync(new URL('../contract/CLASSIFICATION.md', import.meta.url), 'utf8')

const COMPARED = COMPARED_POINTERS as readonly string[]

const A_COMPARED_POINTER = '/api/constraints/monitor.name/max_length'

const POINTER = '/api/constraints/*/forbidden_ranges'

interface Held {
  readonly patterns: readonly string[]
  readonly bound: string | undefined
  readonly cells: Readonly<Record<string, string | undefined>>
}

function rowOf(markdown: string, row: string): Held | undefined {
  return parseRuleTable(markdown).get(row) as Held | undefined
}

function holdsTheDecidedRows(markdown: string): boolean {
  const widened = rowOf(markdown, '50')
  const narrowed = rowOf(markdown, '51')

  return (
    widened?.patterns.join() === POINTER &&
    widened.bound === 'widened' &&
    JSON.stringify(widened.cells) === JSON.stringify({ added: 'undecidable', removed: 'writers-behind', changed: 'breaking-writers', reordered: undefined }) &&
    narrowed?.patterns.join() === POINTER &&
    narrowed.bound === 'narrowed' &&
    JSON.stringify(narrowed.cells) === JSON.stringify({ added: undefined, removed: undefined, changed: 'writers-behind', reordered: undefined })
  )
}

const EDITORIAL_HEADING = /^### Editorial.*$/m

function saysPatchBumpOnce(markdown: string): boolean {
  const verdicts = markdown.slice(markdown.indexOf('## Verdicts'), markdown.indexOf('## Directions'))

  return (
    /An editorial-only change[^.]*is a\s+patch bump/.test(verdicts) &&
    /patch/.test(EDITORIAL_HEADING.exec(markdown)?.[0] ?? '') &&
    !/version-bumping|no bump/i.test(markdown)
  )
}

describe('the forbidden code points of a name and a label are classified', () => {
  it('documents a refusal that grows as breaking writers and one that shrinks as writers-behind', () => {
    expect(holdsTheDecidedRows(RULES)).toBe(true)
  })

  it('names a pointer the drift watch compares no fact of', () => {
    expect(COMPARED.filter((pointer) => matches(POINTER, pointer))).toEqual([])
  })

  it('goes red when the drift watch compares a pointer the row names', () => {
    const grown = [...COMPARED, '/api/constraints/monitor.name/forbidden_ranges']

    expect(grown.filter((pointer) => matches(POINTER, pointer))).toEqual(['/api/constraints/monitor.name/forbidden_ranges'])
  })

  it('goes red when a documented verdict is changed', () => {
    const flipped = RULES.replace(/(\| 51 \|[^\n]*?)`writers-behind`/, '$1`additive`')

    expect(flipped).not.toBe(RULES)
    expect(holdsTheDecidedRows(flipped)).toBe(false)
  })

  it('goes red when the widened verdict is changed', () => {
    const flipped = RULES.replace('`breaking-writers` — a code point the service used to accept', '`breaking-both` — a code point the service used to accept')

    expect(flipped).not.toBe(RULES)
    expect(holdsTheDecidedRows(flipped)).toBe(false)
  })

  it('goes red when the narrowed row loses its bound', () => {
    const swapped = RULES.replace(/(\| 51 \|[^\n]*?)\*\*narrowed\*\*/, '$1**widened**')

    expect(swapped).not.toBe(RULES)
    expect(holdsTheDecidedRows(swapped)).toBe(false)
  })

  it('goes red when a documented bound is swapped', () => {
    const swapped = RULES.replace(/(\| 50 \|[^\n]*?)\*\*widened\*\*/, '$1**narrowed**')

    expect(swapped).not.toBe(RULES)
    expect(holdsTheDecidedRows(swapped)).toBe(false)
  })

  it('goes red when the row is claimed for a pointer the drift watch compares', () => {
    const claimed = RULES.replace(POINTER, A_COMPARED_POINTER)
    const found = disagreements(claimed, COMPARED)

    expect(claimed).not.toBe(RULES)
    expect(found.filter((message: string) => message.startsWith('rule 50 — the rule table places'))).toHaveLength(1)
  })

  it('goes red when the row is dropped', () => {
    const dropped = RULES.split('\n').filter((line) => !/^\| 50 \|/.test(line)).join('\n')

    expect(holdsTheDecidedRows(dropped)).toBe(false)
  })
})

describe('what an editorial change does to the contract version', () => {
  it('is a patch bump in the verdicts, and the editorial heading does not say otherwise', () => {
    expect(saysPatchBumpOnce(RULES)).toBe(true)
  })

  it('goes red when the heading says the opposite again', () => {
    const contradicted = RULES.replace(EDITORIAL_HEADING, '### Editorial: never a version-bumping verdict on its own')

    expect(contradicted).not.toBe(RULES)
    expect(saysPatchBumpOnce(contradicted)).toBe(false)
  })

  it('goes red when the heading is reworded to say the version stays', () => {
    const reworded = RULES.replace(EDITORIAL_HEADING, '### Editorial: the contract version stays as it was')

    expect(reworded).not.toBe(RULES)
    expect(saysPatchBumpOnce(reworded)).toBe(false)
  })

  it('goes red when the verdicts section stops saying a patch bump', () => {
    const silent = RULES.replace(/is a\s+patch bump, never more\./, 'needs no bump.')

    expect(silent).not.toBe(RULES)
    expect(saysPatchBumpOnce(silent)).toBe(false)
  })
})
