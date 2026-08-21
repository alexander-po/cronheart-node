import { describe, expect, it } from 'vitest'
import { isMonitorId } from '../src/index.js'
import { envVarFor, resolveMonitor } from '../src/ping/resolve.js'
import { InvalidMonitorIdError, UnknownMonitorError } from '../src/wiring/errors.js'
import { resolveOrThrow } from '../src/wiring/validate.js'

const REAL_ID = '00000000-0000-4000-8000-0000000000a1'

// Shaped like an identifier the whole way through: a wrong character, a lost one, the
// dashes stripped. Nothing here is a name somebody chose.
const WHOLLY_ID_SHAPED = [
  '0000000g-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000a1',
  '00000000000040008000000000000a1',
]

// Opens like an identifier and then stops. A monitor may legitimately be called this, so
// its variable still answers — while an unconfigured one is reported as a broken id.
const OPENS_LIKE_AN_ID = ['00000000-0000-4000-8000-0000000000a1x', 'deadbeef-nightly']

const NEARLY_AN_ID = [...WHOLLY_ID_SHAPED, ...OPENS_LIKE_AN_ID]

const NAMES = ['nightly-backup', 'sweep', 'etl-2024', 'a', '../../etc/passwd']

function poisoned(value: string): Record<string, string> {
  return { [envVarFor(value)]: REAL_ID }
}

describe('a value that is nearly a monitor id is diagnosed as a broken id', () => {
  it.each(NEARLY_AN_ID)('refuses %s by naming the id, not a variable nobody set', (value) => {
    expect(() => resolveOrThrow(value, {}, {})).toThrow(InvalidMonitorIdError)
    expect(() => resolveOrThrow(value, {}, {})).toThrow(/not a monitor id/)
  })

  it.each(NEARLY_AN_ID)('never suggests a variable for %s', (value) => {
    expect(resolveMonitor(value, {}, {}).envVar).toBeUndefined()
  })

  it.each(NEARLY_AN_ID)('prints %s back redacted, because it is one edit from a credential', (value) => {
    const label = resolveMonitor(value, {}, {}).label

    expect(label).not.toBe(value)
    expect(label.startsWith('id…')).toBe(true)
  })
})

describe('a value shaped like an id all the way through is never looked up in the environment', () => {
  it.each(WHOLLY_ID_SHAPED)(
    'leaves %s unresolved even where a variable would answer for it',
    (value) => {
      const environment = poisoned(value)

      expect(Object.values(environment)).toEqual([REAL_ID])
      expect(resolveMonitor(value, {}, environment).id).toBeUndefined()
      expect(() => resolveOrThrow(value, {}, environment)).toThrow(InvalidMonitorIdError)
    },
  )

  it.each(OPENS_LIKE_AN_ID)(
    'keeps reading it for %s, which a monitor may legitimately be called',
    (value) => {
      expect(resolveMonitor(value, {}, poisoned(value)).id).toBe(REAL_ID)
    },
  )

  it('still reads the environment for an ordinary name, so the rule is about shape', () => {
    expect(resolveMonitor('nightly-backup', {}, poisoned('nightly-backup')).id).toBe(REAL_ID)
  })
})

describe('a monitor name is still a monitor name', () => {
  it.each(NAMES)('resolves %s through the variable named for it', (name) => {
    const resolution = resolveMonitor(name, {}, poisoned(name))

    expect(resolution.id).toBe(REAL_ID)
    expect(resolution.reason).toBe('ok')
  })

  it.each(NAMES)('asks for the variable by name when %s resolves to nothing', (name) => {
    expect(() => resolveOrThrow(name, {}, {})).toThrow(UnknownMonitorError)
    expect(resolveMonitor(name, {}, {}).envVar).toBe(envVarFor(name))
  })

  it('spells one of those variables out, so the rule above is not the mangler agreeing with itself', () => {
    expect(resolveMonitor('nightly-backup', {}, {}).envVar).toBe('CRONHEART_NIGHTLY_BACKUP_UUID')
  })

  it('takes a canonical id as an id, ahead of everything above', () => {
    expect(resolveMonitor(REAL_ID, {}, {}).id).toBe(REAL_ID)
  })
})

describe('the id-shape predicate the CLI validates with is on the published surface', () => {
  it('accepts a canonical id and refuses each near miss, so a consumer keeps no copy of it', () => {
    expect(isMonitorId(REAL_ID)).toBe(true)
    expect(NEARLY_AN_ID.filter((value) => isMonitorId(value))).toEqual([])
    expect(NAMES.filter((value) => isMonitorId(value))).toEqual([])
  })
})
