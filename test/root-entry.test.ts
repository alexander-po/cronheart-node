import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIn, checkInWith, monitors } from '../src/index.js'
import { sharedClientKey } from '../src/ping/default.js'
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

  it('reads the environment live, so wiring order does not decide the outcome', () => {
    expect(() => monitors.resolve('env-only-job')).toThrow(UnknownMonitorError)

    process.env['CRONHEART_ENV_ONLY_JOB_UUID'] = MONITOR_ID

    expect(monitors.resolve('env-only-job')).toBe(MONITOR_ID)
  })
})

// Two copies of one major share a client, so flush() on either awaits every check-in the
// other started. Under 0.x a breaking change ships in the minor, and a key carrying only
// the major would be the constant zero for every version this package will ever publish.
describe('the key the copies of this package find each other by', () => {
  it.each([
    ['a patch inside 0.x', '0.1.0', '0.1.9', true],
    ['a minor inside 0.x, which is where 0.x breaks', '0.1.0', '0.2.0', false],
    ['a patch inside 1.x', '1.4.0', '1.4.9', true],
    ['a minor inside 1.x, which is additive', '1.4.0', '1.9.0', true],
    ['a major', '1.9.0', '2.0.0', false],
    ['a patch inside 0.0.x, where every release may break', '0.0.1', '0.0.2', false],
  ])('adopts across %s: %s and %s', (_what, one, other, shared) => {
    expect(sharedClientKey(one) === sharedClientKey(other)).toBe(shared)
  })

  it('installs the key its own version derives, so the two cannot drift apart', async () => {
    await checkIn('a-name-nothing-defines')

    expect(Object.getOwnPropertySymbols(globalThis).map((key) => Symbol.keyFor(key))).toContain(
      sharedClientKey(version),
    )
  })
})

// The client these entry points share is built on the first check-in, which is inside the
// job — so these run in a process of their own, where that first build is the one under
// test. An in-process test is structurally blind here: the suite above already cached a
// working client on the same globalThis.
function inItsOwnProcess(
  source: string,
  env: Readonly<Record<string, string>>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  })
}

const EVERY_ROOT_ENTRY = `
const cronheart = await import('./dist/index.mjs')
const report = { has: cronheart.monitors.has('nightly-backup') }
let ran = false
report.returned = await cronheart.withMonitor('nightly-backup', () => {
  ran = true

  return 7
})
report.ran = ran
report.checkedIn = (await cronheart.checkIn('nightly-backup')).outcome
try {
  report.resolved = cronheart.monitors.resolve('nightly-backup')
} catch (error) {
  report.resolved = 'threw ' + error.name
}
try {
  cronheart.checkInWith('nightly-backup')()
  report.thunk = 'built'
} catch (error) {
  report.thunk = 'threw ' + error.name
}
cronheart.monitors.define({ 'a-job-defined-in-code': '${MONITOR_ID}' })
report.defined = cronheart.monitors.has('a-job-defined-in-code')
report.ended = (await cronheart.startRun('nightly-backup').success()).outcome
await cronheart.flush()
process.stdout.write(JSON.stringify(report))
`

const DEFINED_WHILE_THE_URL_WAS_BROKEN = `
const cronheart = await import('./dist/index.mjs')
const before = (await cronheart.checkIn('a-job-defined-in-code')).outcome
cronheart.monitors.define({ 'a-job-defined-in-code': '${MONITOR_ID}' })
process.env.CRONHEART_URL = 'http://127.0.0.1:9'
const after = (await cronheart.checkIn('a-job-defined-in-code')).outcome
process.stdout.write(JSON.stringify({ before, after }))
`

const AN_ENVIRONMENT_THAT_CANNOT_BE_READ = `
const cronheart = await import('./dist/index.mjs')
Object.defineProperty(process, 'env', {
  configurable: true,
  get() {
    throw new TypeError('the environment exploded')
  },
})
let ran = false
let report
try {
  const returned = await cronheart.withMonitor('nightly-backup', () => {
    ran = true

    return 7
  })
  report = { ran, returned, threw: null }
} catch (error) {
  report = { ran, returned: null, threw: error.name }
}
Object.defineProperty(process, 'env', { configurable: true, value: {} })
process.stdout.write(JSON.stringify(report))
`

describe('a base URL the deployment got wrong reaches the caller as an outcome', () => {
  it('runs the job, sends nothing, and says what is wrong rather than throwing into it', () => {
    const ran = inItsOwnProcess(EVERY_ROOT_ENTRY, {
      CRONHEART_URL: 'cronheart.com',
      CRONHEART_NIGHTLY_BACKUP_UUID: MONITOR_ID,
    })

    expect(`${ran.stderr}`).toContain('cannot be a base URL')
    expect(ran.status).toBe(0)
    expect(JSON.parse(ran.stdout) as unknown).toEqual({
      has: true,
      ran: true,
      returned: 7,
      checkedIn: 'suppressed',
      resolved: MONITOR_ID,
      thunk: 'built',
      defined: true,
      ended: 'suppressed',
    })
  })

  it('hands a fixed environment a client that carries what was defined before the fix', () => {
    const ran = inItsOwnProcess(DEFINED_WHILE_THE_URL_WAS_BROKEN, {
      CRONHEART_URL: 'cronheart.com',
      CRONHEART_RETRIES: '0',
      CRONHEART_TIMEOUT_MS: '2000',
    })

    expect(ran.status).toBe(0)
    expect(JSON.parse(ran.stdout) as unknown).toEqual({
      before: 'suppressed',
      after: 'network-error',
    })
  })

  it('still builds the refusing client when the environment itself cannot be read', () => {
    const ran = inItsOwnProcess(AN_ENVIRONMENT_THAT_CANNOT_BE_READ, {})

    expect(ran.status).toBe(0)
    expect(JSON.parse(ran.stdout) as unknown).toEqual({ ran: true, returned: 7, threw: null })
  })
})
