import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIn, checkInWith, monitors } from '../src/index.js'
import { clearWarnings } from '../src/testing.js'
import { UnknownMonitorError } from '../src/wiring/errors.js'

const MONITOR_ID = '00000000-0000-4000-8000-0000000000c3'

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

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

  it('keys the shared client on the major, so two majors in one tree cannot adopt each other', async () => {
    const major = version.slice(0, version.indexOf('.'))

    await checkIn('a-name-nothing-defines')

    expect(major).not.toBe('')
    expect(Object.getOwnPropertySymbols(globalThis).map((key) => Symbol.keyFor(key))).toContain(
      `cronheart.defaultClient/${major}`,
    )
  })

  it('reads the environment live, so wiring order does not decide the outcome', () => {
    expect(() => monitors.resolve('env-only-job')).toThrow(UnknownMonitorError)

    process.env['CRONHEART_ENV_ONLY_JOB_UUID'] = MONITOR_ID

    expect(monitors.resolve('env-only-job')).toBe(MONITOR_ID)
  })
})

// The client these entry points share is built on the first check-in, which is inside the
// job — so this runs in a process of its own, where that first build is the one under test.
const THROUGH_THE_ROOT_ENTRY = `
const cronheart = await import('./dist/index.mjs')
const checkedIn = await cronheart.checkIn('a-monitor-nobody-configured')
let ran = false
const returned = await cronheart.withMonitor('a-monitor-nobody-configured', () => {
  ran = true

  return 7
})
await cronheart.flush()
process.stdout.write(JSON.stringify({ ran, returned, outcome: checkedIn.outcome, sent: checkedIn.sent }))
`

describe('a base URL the deployment got wrong reaches the caller as an outcome', () => {
  it('runs the job, sends nothing, and says what is wrong rather than throwing into it', () => {
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', THROUGH_THE_ROOT_ENTRY], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', CRONHEART_URL: 'cronheart.com' },
    })

    expect(`${ran.stderr}`).toContain('cannot be a base URL')
    expect(ran.status).toBe(0)
    expect(JSON.parse(ran.stdout) as unknown).toEqual({
      ran: true,
      returned: 7,
      outcome: 'suppressed',
      sent: false,
    })
  })
})
