import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIn, checkInWith, monitors } from '../src/index.js'
import { clearWarnings } from '../src/ping/warn.js'
import { UnknownMonitorError } from '../src/wiring/errors.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000c3'

beforeEach(() => {
  clearWarnings()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['CRONHEART_ENV_ONLY_JOB_UUID']
})

describe('the root entry points share one client', () => {
  it('sends nothing and never rejects when a name resolves to nothing', async () => {
    const result = await checkIn('a-name-nothing-defines')

    expect(result.outcome).toBe('suppressed')
    expect(result.sent).toBe(false)
  })

  it('takes ids defined at wiring time and hands them to every entry point', () => {
    monitors.define({ 'root-job': MONITOR_ID })

    expect(monitors.resolve('root-job')).toBe(MONITOR_ID)
    expect(monitors.has('root-job')).toBe(true)
    expect(() => checkInWith('root-job')).not.toThrow()
  })

  it('reads the environment live, so wiring order does not decide the outcome', () => {
    expect(() => monitors.resolve('env-only-job')).toThrow(UnknownMonitorError)

    process.env['CRONHEART_ENV_ONLY_JOB_UUID'] = MONITOR_ID

    expect(monitors.resolve('env-only-job')).toBe(MONITOR_ID)
  })
})
