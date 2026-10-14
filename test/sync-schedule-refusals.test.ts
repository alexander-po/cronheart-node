import { describe, expect, it } from 'vitest'
import { defineMonitors } from '../src/sync/define.js'
import { SyncConfigurationError } from '../src/sync/errors.js'

const OVERRIDE = '\u202E'

const LINE_SEPARATOR = '\u2028'

const BELL = '\u0007'

const PATHS = [
  ['an unknown alias', (spelled: string) => `@${spelled}reboot`, [OVERRIDE, LINE_SEPARATOR, BELL]],
  ['a word where a cron field belongs', (spelled: string) => `a${spelled}b c d e f`, [OVERRIDE, BELL]],
  ['a cron object with a word in a field', (spelled: string) => ({ cron: `a${spelled}b c d e f` }), [OVERRIDE, BELL]],
  ['an interval that is not one', (spelled: string) => ({ every: `5${spelled}m` }), [OVERRIDE, LINE_SEPARATOR, BELL]],
  ['an interval object that is not one', (spelled: string) => ({ interval: `5${spelled}m` }), [OVERRIDE, LINE_SEPARATOR, BELL]],
  ['a simple schedule that is not named', (spelled: string) => ({ simple: `ho${spelled}urly` }), [OVERRIDE, LINE_SEPARATOR, BELL]],
  ['a lone word that is nothing', (spelled: string) => `fo${spelled}o`, [OVERRIDE, BELL]],
] as const

function refusalOf(schedule: unknown): string {
  try {
    defineMonitors([{ name: 'job', schedule } as never])
  } catch (error) {
    expect(error).toBeInstanceOf(SyncConfigurationError)

    return (error as Error).message
  }

  throw new Error('the schedule was accepted')
}

function codePointName(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

describe('a schedule the sync configuration refuses is shown without a code point a terminal would act on', () => {
  for (const [path, build, characters] of PATHS) {
    it.each(characters.map((character) => [codePointName(character), character] as const))(
      `spells out %s in ${path}`,
      (name, character) => {
        const message = refusalOf(build(character))

        expect(message).toContain(name)
        expect(message).not.toContain(character)
      },
    )
  }

  it('leaves an ordinary refusal as it was', () => {
    expect(refusalOf('@reboot')).toContain('"@reboot" is not a schedule alias this service knows')
    expect(refusalOf({ every: '5x' })).toContain('"5x" is not an interval')
  })
})

const FIELD_SEPARATORS = [
  ['a carriage return', '\r'],
  ['a line feed', '\n'],
  ['a vertical tab', '\u000B'],
  ['a form feed', '\u000C'],
  ['a no-break space', '\u00A0'],
  ['a line separator', '\u2028'],
  ['an ideographic space', '\u3000'],
] as const

describe('a cron expression is split on spaces and tabs only', () => {
  it.each(FIELD_SEPARATORS)('refuses %s between fields, as a string and as an object', (_what, separator) => {
    const expression = ['0', '4', '*', '*', '*'].join(separator)

    for (const schedule of [expression, { cron: expression }]) {
      const message = refusalOf(schedule)

      expect(message).toContain(`separates its fields with ${codePointName(separator)}.`)
      expect(message).toContain('spaces or tabs')
      expect(message).not.toContain(separator)
    }
  })

  it('accepts spaces and tabs, and sends the expression as it was written', () => {
    const { monitors } = defineMonitors([{ name: 'job', schedule: '0\t4  *\t*  *' } as never])

    expect(monitors[0]?.scheduleExpr).toBe('0\t4  *\t*  *')
  })

  it('still reports a wrong field count for an expression separated by spaces', () => {
    expect(refusalOf('0 4 * *')).toContain('has 4')
  })
})
