import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertMonitorUuid } from '../src/api/validate.js'
import { withoutIdentifiers } from '../src/api/problem.js'
import { IDENTIFIER_SHAPED, UUID_WHOLE, hideIdentifierSegments } from '../src/identifier-shape.js'
import { isMonitorId } from '../src/index.js'
import { MONITOR_UUID, apiWith } from './support/api-recorder.js'

const LETTERED = ['f'.repeat(8), 'e'.repeat(4), 'd'.repeat(4), 'c'.repeat(4), 'b'.repeat(12)].join('-')

const ELEVEN = ['0'.repeat(8), '0'.repeat(4), '0'.repeat(4), '0'.repeat(4), '0'.repeat(11)].join('-')

const COMPACT = `${'0'.repeat(31)}3`

const WHOLE_ACCEPTED = [
  ['all zeros', MONITOR_UUID],
  ['lower case', LETTERED],
  ['upper case', LETTERED.toUpperCase()],
  ['mixed case', `${'F'.repeat(4)}${'f'.repeat(4)}-${'E'.repeat(4)}-${'d'.repeat(4)}-${'C'.repeat(4)}-${'b'.repeat(12)}`],
] as const

const WHOLE_REFUSED = [
  ['a character before', `a${MONITOR_UUID}`],
  ['a character after', `${MONITOR_UUID}a`],
  ['a trailing line break', `${MONITOR_UUID}\n`],
  ['a leading space', ` ${MONITOR_UUID}`],
  ['one digit short in the last group', ELEVEN],
  ['one digit too many in the last group', `${MONITOR_UUID}0`],
  ['no dashes', COMPACT],
  ['a non-hex letter', `g${MONITOR_UUID.slice(1)}`],
  ['an empty string', ''],
] as const

describe('the whole-string shape', () => {
  it.each(WHOLE_ACCEPTED)('accepts %s', (_name, value) => {
    expect(UUID_WHOLE.test(value)).toBe(true)
  })

  it.each(WHOLE_REFUSED)('refuses %s', (_name, value) => {
    expect(UUID_WHOLE.test(value)).toBe(false)
  })
})

describe('the monitor id check on the check-in path reads the whole-string shape', () => {
  it.each(WHOLE_ACCEPTED)('accepts %s', (_name, value) => {
    expect(isMonitorId(value)).toBe(true)
  })

  it.each(WHOLE_REFUSED)('refuses %s', (_name, value) => {
    expect(isMonitorId(value)).toBe(false)
  })

  it('refuses a value that is not a string', () => {
    expect(isMonitorId(undefined)).toBe(false)
    expect(isMonitorId(7)).toBe(false)
  })
})

describe('the management client reads the whole-string shape', () => {
  it.each(WHOLE_ACCEPTED)('accepts %s', (_name, value) => {
    expect(() => assertMonitorUuid(value)).not.toThrow()
  })

  it.each(WHOLE_REFUSED)('refuses %s', (_name, value) => {
    expect(() => assertMonitorUuid(value)).toThrow('not a monitor identifier')
  })

  it.each(WHOLE_REFUSED.filter(([, value]) => value !== ''))('sends nothing for %s', async (_name, value) => {
    const { api, recorder } = apiWith({ status: 200, json: {} })

    await expect(api.monitors.get(value)).rejects.toThrow('not a monitor identifier')
    expect(recorder.requests).toEqual([])
  })
})

const SEGMENT_REPLACED = [
  ['a segment at the end', `/monitors/${MONITOR_UUID}`, '/monitors/{uuid}'],
  ['a segment before another segment', `/monitors/${MONITOR_UUID}/pings`, '/monitors/{uuid}/pings'],
  ['a segment in upper case', `/monitors/${LETTERED.toUpperCase()}/pause`, '/monitors/{uuid}/pause'],
  ['every segment, not only the first', `/a/${MONITOR_UUID}/b/${LETTERED}`, '/a/{uuid}/b/{uuid}'],
] as const

const SEGMENT_KEPT = [
  ['a query after it', `/monitors/${MONITOR_UUID}?x=1`],
  ['a hex digit after it', `/monitors/${MONITOR_UUID}0`],
  ['a dash after it', `/monitors/${MONITOR_UUID}-x`],
  ['no slash before it', `monitors${MONITOR_UUID}`],
  ['a character joined to it before the slash', `/monitors/a${MONITOR_UUID}`],
  ['one digit short in the last group', `/monitors/${ELEVEN}`],
  ['no dashes', `/monitors/${COMPACT}`],
] as const

describe('the path segment shape', () => {
  it.each(SEGMENT_REPLACED)('replaces %s', (_name, path, shown) => {
    expect(hideIdentifierSegments(path)).toBe(shown)
  })

  it.each(SEGMENT_KEPT)('leaves %s alone', (_name, path) => {
    expect(hideIdentifierSegments(path)).toBe(path)
  })

  it('names the monitor by a placeholder in a failure and never by its id', async () => {
    const { api } = apiWith({ status: 404, json: {} })
    const failure = await api.monitors.get(MONITOR_UUID).then(
      () => undefined,
      (error: unknown) => error as Error & { request?: { path?: string } },
    )

    expect(failure?.message).toContain('/monitors/{uuid}')
    expect(failure?.request?.path).toBe('/api/v1/monitors/{uuid}')
    expect(JSON.stringify(failure?.request)).not.toContain(MONITOR_UUID)
    expect(failure?.message).not.toContain(MONITOR_UUID)
  })
})

const SHAPED = [
  ['a hyphenated id', MONITOR_UUID],
  ['a hyphenated id in upper case', LETTERED.toUpperCase()],
  ['a hyphenated id inside text', `see ${LETTERED} for it`],
  ['a hyphenated id after another hex digit', `a${MONITOR_UUID}`],
  ['a hyphenated id before another hex digit', `${MONITOR_UUID}0`],
  ['a bare run of 32 hex digits', COMPACT],
  ['a bare run of 32 hex digits in upper case', COMPACT.replace('3', 'F')],
  ['a bare run of 32 hex digits between non-hex characters', `_${COMPACT}_`],
  ['a hyphenated id written with non-breaking hyphens', MONITOR_UUID.replaceAll('-', '\u2011')],
  ['a hyphenated id written with en dashes', MONITOR_UUID.replaceAll('-', '\u2013')],
  ['a hyphenated id written with one look-alike among real dashes', MONITOR_UUID.replace('-', '\u2011')],
] as const

const NOT_SHAPED = [
  ['one digit short in the last group, then a non-hex character', `${ELEVEN}-x`],
  ['one digit short in the last group, then a space', `${ELEVEN} x`],
  ['a run of 31 hex digits', COMPACT.slice(1)],
  ['a run of 33 hex digits', `0${COMPACT}`],
  ['32 hex digits after a hex digit', `f${COMPACT}`],
  ['32 hex digits before a hex digit', `${COMPACT}a`],
  ['grouped 8-4-4-4-12 but not hex', ['g'.repeat(8), 'h'.repeat(4), 'i'.repeat(4), 'j'.repeat(4), 'k'.repeat(12)].join('-')],
] as const

describe('the identifier-shaped text shape', () => {
  it('leaves the shape that gates the wire strict about its dashes', () => {
    expect(UUID_WHOLE.test(MONITOR_UUID.replaceAll('-', '\u2011'))).toBe(false)
    expect(UUID_WHOLE.test(MONITOR_UUID.replaceAll('-', '\u2013'))).toBe(false)
  })

  it.each(SHAPED)('matches %s', (_name, text) => {
    expect(IDENTIFIER_SHAPED.test(text)).toBe(true)
  })

  it.each(NOT_SHAPED)('does not match %s', (_name, text) => {
    expect(IDENTIFIER_SHAPED.test(text)).toBe(false)
  })

  it.each(SHAPED)('drops a problem field holding %s', (_name, text) => {
    const problem = {
      status: 422,
      title: text,
      detail: text,
      errors: { [text]: 'x', ok: text, kept: 'fine' },
      upgradeUrl: text,
      retryAfterSeconds: undefined,
    }

    expect(withoutIdentifiers(problem)).toEqual({
      ...problem,
      title: undefined,
      detail: undefined,
      errors: { kept: 'fine' },
      upgradeUrl: undefined,
    })
  })

  it.each(NOT_SHAPED)('keeps a problem field holding %s', (_name, text) => {
    const problem = {
      status: 422,
      title: text,
      detail: text,
      errors: { [text]: text },
      upgradeUrl: text,
      retryAfterSeconds: undefined,
    }

    expect(withoutIdentifiers(problem)).toEqual(problem)
  })
})

const SOURCE_ROOT = fileURLToPath(new URL('../src', import.meta.url))

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)

    return statSync(path).isDirectory() ? sourcesUnder(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('the hex grouping is written once', () => {
  it('appears as a lower-case hex class only in the shared module', () => {
    const holders = sourcesUnder(SOURCE_ROOT)
      .filter((file) => /\[0-9a-f\]\{8\}-/.test(readFileSync(file, 'utf8')))
      .map((file) => join('src', relative(SOURCE_ROOT, file)))

    expect(holders).toEqual(['src/identifier-shape.ts'])
  })
})
