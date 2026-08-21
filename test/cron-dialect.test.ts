import { describe, expect, it } from 'vitest'
import {
  CRON_ALIASES,
  CRON_FIELD_COUNT,
  cronDialectRefusal,
  readsAsAnHourOfTheDay,
} from '../src/cron-dialect.js'
import { CRON_ALIASES as API_ALIASES, CRON_FIELD_COUNT as API_FIELDS } from '../src/api/constants.js'

describe('the schedulers’ cron dialect against the service’s', () => {
  it('takes the five-field expressions the service takes', () => {
    for (const expression of ['0 3 * * *', '*/5 * * * *', '0 0 1 * *', '15 2 * * MON']) {
      expect(cronDialectRefusal(expression, 'croner')).toBeUndefined()
    }
  })

  it('refuses the six-field form and says whose dialect wrote it', () => {
    const refusal = cronDialectRefusal('0 0 3 * * *', 'croner')

    expect(refusal).toContain('croner')
    expect(refusal).toContain('seconds')
    expect(refusal).toContain('6 fields')
  })

  it('refuses fewer than five fields too, which no scheduler would have accepted either', () => {
    expect(cronDialectRefusal('0 3 * *', 'node-cron')).toContain('4 fields')
    expect(cronDialectRefusal('* * * * * * *', 'node-cron')).toContain('7 fields')
  })

  it('takes the seven aliases and refuses @reboot by name', () => {
    for (const alias of CRON_ALIASES) {
      expect(cronDialectRefusal(alias, 'croner')).toBeUndefined()
      expect(cronDialectRefusal(alias.toUpperCase(), 'croner')).toBeUndefined()
    }

    expect(cronDialectRefusal('@reboot', 'croner')).toContain('@reboot')
    expect(cronDialectRefusal('@every 5m', 'croner')).toContain('alias')
  })

  it('is the same alias list and field count the management client validates against', () => {
    expect(API_ALIASES).toBe(CRON_ALIASES)
    expect(API_FIELDS).toBe(CRON_FIELD_COUNT)
  })
})

describe('whether a schedule reads as an hour of the day', () => {
  it('says yes when the expression names hours and no when it only names a step', () => {
    expect(readsAsAnHourOfTheDay('0 3 * * *')).toBe(true)
    expect(readsAsAnHourOfTheDay('30 2,14 * * *')).toBe(true)
    expect(readsAsAnHourOfTheDay('*/5 * * * *')).toBe(false)
    expect(readsAsAnHourOfTheDay('0 */6 * * *')).toBe(false)
  })

  it('separates the aliases that name an hour from the one that does not', () => {
    expect(readsAsAnHourOfTheDay('@daily')).toBe(true)
    expect(readsAsAnHourOfTheDay('@midnight')).toBe(true)
    expect(readsAsAnHourOfTheDay('@hourly')).toBe(false)
  })
})
