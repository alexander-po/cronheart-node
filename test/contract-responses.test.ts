import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PING_DUPLICATE_BODY,
  PING_STATUS_OUTCOMES,
  classifyStatus,
} from '../src/ping/outcome.js'

interface ResponseRow {
  readonly status: number | string
  readonly body?: string
  readonly outcome: string
}

interface VectorCase {
  readonly id: string
  readonly input: { readonly status: number; readonly body: string }
}

const table = (
  JSON.parse(
    readFileSync(new URL('../contract/cronheart-contract.json', import.meta.url), 'utf8'),
  ) as { ping: { responses: { table: readonly ResponseRow[] } } }
).ping.responses.table

const cases = (
  JSON.parse(
    readFileSync(
      new URL('../contract/vectors/ping-response-classification.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: readonly VectorCase[] }
).cases

function statusesFor(row: ResponseRow): number[] {
  if (typeof row.status === 'number') {
    return [row.status]
  }

  const family = Number(row.status.slice(0, 1))

  return [family * 100, family * 100 + 99]
}

function covers(vectorCase: VectorCase, row: ResponseRow): boolean {
  const [low, high] = statusesFor(row)
  const inRange =
    vectorCase.input.status >= Number(low) && vectorCase.input.status <= Number(high ?? low)

  return inRange && (row.body === undefined || vectorCase.input.body === row.body)
}

describe('the ping response table', () => {
  it('states rows at all, so nothing below can agree with it by being empty', () => {
    expect(table.length).toBeGreaterThan(0)
    expect(cases.length).toBeGreaterThan(table.length)
  })

  it.each(table.map((row) => [`${String(row.status)} ${row.body ?? ''}`.trim(), row] as const))(
    'classifies %s the way the contract states',
    (_label, row) => {
      for (const status of statusesFor(row)) {
        expect(classifyStatus(status, row.body ?? '')).toBe(row.outcome)
      }
    },
  )

  it.each(table.map((row) => [`${String(row.status)} ${row.body ?? ''}`.trim(), row] as const))(
    'has a conformance case for %s',
    (_label, row) => {
      expect(cases.filter((vectorCase) => covers(vectorCase, row)).map((one) => one.id)).not.toEqual(
        [],
      )
    },
  )

  it('holds the duplicate literal the table states, rather than a copy of it', () => {
    const duplicate = table.find((row) => row.outcome === 'duplicate')

    expect(duplicate?.body).toBe(PING_DUPLICATE_BODY)
    expect(classifyStatus(Number(duplicate?.status), String(duplicate?.body))).toBe('duplicate')
  })

  it.each(
    table
      .filter((row) => row.outcome !== 'duplicate')
      .map((row) => [String(row.status), row] as const),
  )('projects %s onto the status arm the SDK reads', (key, row) => {
    const stated = PING_STATUS_OUTCOMES as Readonly<Record<string, string | undefined>>
    const family = `${key.slice(0, 1)}xx`

    expect(stated[key] ?? stated[family]).toBe(row.outcome)
  })
})
