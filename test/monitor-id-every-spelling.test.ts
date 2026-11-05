import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPingClient } from '../src/ping/client.js'
import { createPingRecorder } from '../src/testing.js'
import { envVarFor, labelFor, resolveMonitor } from '../src/ping/resolve.js'
import { defineMonitors } from '../src/sync/define.js'
import { envLinesFor } from '../src/sync/render.js'
import { MONITOR_ID, type PingServer, runCli, startPingServer } from './support/cli.js'

const ID = ['0a1b2c3d', '1111', '2222', '3333', '4444555566ff'].join('-')

const COMPACT = ID.replaceAll('-', '')

const FULLWIDTH = [...ID].map((c) => (/[0-9]/.test(c) ? String.fromCodePoint(0xff10 + Number(c)) : c)).join('')

const MATH_ZERO = '\u{1D7CE}'

const SPELLINGS = [
  ['a compact id after a hex digit', `job a${COMPACT}`],
  ['a compact id before a hex digit', `job ${COMPACT}f`],
  ['an id missing its first dash', `tenant ${ID.replace('-', '')}`],
  ['an id missing its last dash', `tenant ${ID.replace('3333-', '3333')}`],
  ['an id with a trade mark sign between two groups', `job ${ID.replace('-', '\u2122')}`],
  ['an id with a combining mark inside a group', `nightly ${ID.replace('0a', '0a\u0301')}`],
  ['an id with a dash missing and spaces between the groups', `tenant ${ID.replace('-', '').replaceAll('-', ' ')}`],
  ['an id grouped in fours with spaces', `nightly ${COMPACT.replace(/(.{4})(?!$)/g, '$1 ')} run`],
  ['an id with a tab and spaces between the groups', `nightly ${ID.replace('-', '\t').replaceAll('-', ' ')}`],
  ['an id with no-break spaces between the groups', `nightly ${ID.replace('-', ' ').replaceAll('-', '\u00A0')}`],
  ['an id with a zero-width space inside a group', `tenant ${ID.replace('1111', '11\u200B11')}`],
  ['an id with a Cyrillic letter between each group', `job ${ID.replaceAll('-', '\u0436')}`],
  ['a compact id with a Hangul filler inside it', `tenant ${COMPACT.slice(0, 12)}\u1160${COMPACT.slice(12)}`],
  ['an id with u with diaeresis between the groups', `job ${ID.replaceAll('-', '\u00FC')}`],
  ['an id with n with tilde between the groups', `job ${ID.replaceAll('-', '\u00F1')}`],
  ['an id with o with acute between the groups', `job ${ID.replaceAll('-', '\u00F3')}`],
  ['an id with s with caron between the groups', `job ${ID.replaceAll('-', '\u0161')}`],
  ['an id with the Kelvin sign between the groups', `job ${ID.replaceAll('-', '\u212A')}`],
] as const

const DRAWN_AS_AN_ID = [
  ['an id ending in a ligature', `tenant ${ID.slice(0, -2)}\uFB00`],
  ['a compact id ending in a ligature after a hex digit', `a${COMPACT.slice(0, -2)}\uFB00`],
  ['an id in fullwidth digits', `tenant ${FULLWIDTH}`],
  ['an id opening with a mathematical zero and a trade mark sign between two groups', `tenant ${MATH_ZERO}${ID.slice(1).replace('-', '\u2122')}`],
] as const

const ID_THROUGH_SPELLED_OUT = new RegExp([...COMPACT].join('(?:[^0-9a-f]|U\\+[0-9a-f]{4,6})*'), 'i')

function holdsTheId(text: string): boolean {
  return [text, text.normalize('NFKC'), text.normalize('NFKD')].some((form) => ID_THROUGH_SPELLED_OUT.test(form))
}

const UNPRINTED = /[\u0080-\u009F\u202A-\u202E\u2066-\u2069\u200B]|[\u{E0000}-\u{E0FFF}]/u

const OUTSIDE_THE_PRINT_SET = [
  ['a C1 control', 'night\u009B31m', 'U+009B'],
  ['a direction override', 'night\u202Ely', 'U+202E'],
  ['a tag character', 'night\u{E0041}ly', 'U+E0041'],
] as const

const ORDINARY = [
  ['Cyrillic', 'ночной-бэкап'],
  ['an accented name in NFC', 'caf\u00E9-backup'],
  ['an accented name in NFD', 'cafe\u0301-backup'],
  ['CJK', '夜間バックアップ'],
  ['a plain emoji', 'backup \u{1F680}'],
  ['an emoji joined by zero-width joiners', 'dev \u{1F469}\u200D\u{1F4BB} job'],
  ['Cyrillic with a date and an address', '\u0412\u044B\u0433\u0440\u0443\u0437\u043A\u0430 \u0441\u0447\u0451\u0442\u0430 2026-03-01 10.0.0.1'],
  ['a French date and time range', 'Run 2026-11-05 03:00:00 \u00E0 2026-11-06 03:00:00.000'],
  ['CJK with an ideographic space', '\u591C\u9593\u3000\u30D0\u30C3\u30AF\u30A2\u30C3\u30D7'],
  ['a no-break space', 'Sauvegarde\u00A0: nuit'],
  ['spaces of other widths', 'night\u2002ly\u2003back\u2009up\u202Fat\u205Fnoon\u1680'],
  ['a flag emoji', 'backup \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
] as const

const ORDINARY_LABELS_WITH_MANY_DIGITS = [
  ['Cyrillic with a long number, a date and a time', '\u0412\u044B\u0433\u0440\u0443\u0437\u043A\u0430 12345678901234567890 \u0437\u0430 2024-05-12 03:00'],
  ['CJK with addresses and ports', '\u5907\u4EFD 10.0.0.1 \u5230 10.0.0.2 \u548C 10.0.0.3 \u53CA 10.0.0.4 \u7AEF\u53E3 5432 8080 9090'],
  ['dates and addresses in Latin script', 'backup 2024-01-01 2024-02-01 2024-03-01 2024-04-01 to 10.0.0.1'],
  ['a French backup between two dates', 'Sauvegarde de 2026-11-05 03:00:00 \u00E0 2026-11-06 03:00:00'],
] as const

let server: PingServer
let workspace: string

beforeEach(async () => {
  server = await startPingServer()
  workspace = mkdtempSync(join(tmpdir(), 'cronheart-spelling-'))
})

afterEach(async () => {
  await server.close()
  rmSync(workspace, { recursive: true, force: true })
})

function envFor(): Record<string, string> {
  return { CRONHEART_URL: server.url, CRONHEART_TIMEOUT_MS: '2000', CRONHEART_RETRIES: '0' }
}

describe('a name holding a monitor id, however it is spelled', () => {
  it('is recognised by the oracle through a code point spelled out between two groups', () => {
    expect(holdsTheId(`nightly ${ID.replace('-', 'U+0009').replace('-', 'U+E0041')}`)).toBe(true)
    expect(holdsTheId(`nightly ${ID.slice(0, 8)}U+0009${ID.slice(10)}`)).toBe(false)
  })

  it('is recognised by the oracle for every spelling, so a green below is not a blind one', () => {
    expect([...SPELLINGS, ...DRAWN_AS_AN_ID].map(([, name]) => holdsTheId(name))).toEqual(
      [...SPELLINGS, ...DRAWN_AS_AN_ID].map(() => true),
    )
  })

  it.each(SPELLINGS)('is shown by its last four digits alone, with no variable named, for %s', (_what, name) => {
    const resolution = resolveMonitor(name, {}, {})

    expect(labelFor(name)).toMatch(/^id…[0-9a-f]{4}$/)
    expect(resolution.label).toBe(labelFor(name))
    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
  })

  it.each(SPELLINGS)('is the monitor a ping result names by its last four digits, for %s', async (_what, name) => {
    const result = await createPingClient({ env: {}, fetch: createPingRecorder().fetch, onResult: () => {} }).ping(name)

    expect(result.monitor).toMatch(/^id…[0-9a-f]{4}$/)
  })

  it.each(SPELLINGS)('is not printed whole by cronheart run for %s', async (_what, name) => {
    const ran = await runCli(['run', `--name=${name}`, '--', 'true'], { env: envFor() })

    expect(ran.stderr).toMatch(/nothing was sent|reads as a monitor id/)
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it.each(SPELLINGS)('is not printed whole by cronheart ping for %s', async (_what, name) => {
    const ran = await runCli(['ping', name], { env: envFor() })

    expect(ran.stderr).toMatch(/nothing was sent/)
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it.each([...SPELLINGS, ...DRAWN_AS_AN_ID])('is refused by cronheart init before anything is written or sent, for %s', async (_what, name) => {
    const path = join(workspace, '.env')
    const ran = await runCli(['init', `--name=${name}`, `--uuid=${MONITOR_ID}`, `--env-path=${path}`], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
    expect(() => readFileSync(path, 'utf8')).toThrow()
    expect(server.requests).toEqual([])
  })

  it('is shown by its last four digits alone when it is an all-decimal compact id', () => {
    expect(labelFor('run 12345678123442348234123456789012')).toBe('id…9012')
    expect(resolveMonitor('run 12345678123442348234123456789012', {}, {}).envVar).toBe('CRONHEART_<NAME>_UUID')
  })

  it('is refused by cronheart init when it is an all-decimal id with a dash missing', async () => {
    const ran = await runCli(['init', '--name=run-123456781234-4234-8234-123456789012', `--uuid=${MONITOR_ID}`, '--print-env'], {
      env: envFor(),
    })

    expect(ran.status).toBe(64)
    expect(ran.stdout).toBe('')
  })

  it('is refused by cronheart init when it is an all-decimal compact id', async () => {
    const path = join(workspace, '.env')
    const ran = await runCli(['init', '--name=run-01234567111122223333444455556666', `--uuid=${MONITOR_ID}`, `--env-path=${path}`], {
      env: envFor(),
    })

    expect(ran.status).toBe(64)
    expect(`${ran.stdout}${ran.stderr}`).not.toContain('01234567111122223333444455556666')
    expect(() => readFileSync(path, 'utf8')).toThrow()
  })

  it.each(SPELLINGS)('is cut from the collision sync refuses, for %s', (_what, name) => {
    const twin = `${name}`.replace(' ', '_')
    const pair = name.includes(' ') ? [name, twin] : [name, `${name}·`]

    expect(envVarFor(pair[0] ?? '')).toBe(envVarFor(pair[1] ?? ''))
    expect(() =>
      defineMonitors(pair.map((monitor) => ({ name: monitor, schedule: '@daily', channels: 'none' as const }))),
    ).toThrow(/both resolve to|name holds/)

    try {
      defineMonitors(pair.map((monitor) => ({ name: monitor, schedule: '@daily', channels: 'none' as const })))
    } catch (error) {
      expect(holdsTheId(String(error))).toBe(false)
    }
  })

  it('reads an id behind a zero-width character as a mistyped id, never as a variable to look up', () => {
    const name = `\u200B${ID}`
    const resolution = resolveMonitor(name, {}, { [envVarFor(name)]: MONITOR_ID })

    expect(resolution.id).toBeUndefined()
    expect(resolution.envVar).toBeUndefined()
    expect(holdsTheId(resolution.label)).toBe(false)
  })

  it('names the swapped key, cut, when a monitors map holds an id where the name belongs', () => {
    const swapped = () => createPingClient({ env: {}, fetch: createPingRecorder().fetch, monitors: { [ID]: 'nightly' } })

    expect(swapped).toThrow(/is not a monitor id/)
    expect(() => {
      try {
        swapped()
      } catch (error) {
        if (holdsTheId(String(error))) {
          throw new Error('the id reached the message')
        }
      }
    }).not.toThrow()
  })

  it.each([
    ['as written', ID],
    ['compact', COMPACT],
  ])('is not echoed whole as an unknown command, %s', async (_how, command) => {
    const ran = await runCli([command, 'ping', 'job'], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('is not a cronheart command')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it('is not echoed whole from an --env-path that holds one', async () => {
    const ran = await runCli(
      ['init', '--name=nightly', `--uuid=${MONITOR_ID}`, `--env-path=${join(workspace, ID, '.env')}`],
      { env: envFor() },
    )

    expect(ran.stderr).toContain('does not exist')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })
})

describe('a name holding characters outside the print set', () => {
  it('is spelled out when tag characters ride behind a black flag in no flag\'s shape', () => {
    const hidden = [...'curl x.invalid'].map((character) => String.fromCodePoint(0xe0000 + character.charCodeAt(0))).join('')
    const label = labelFor(`backup \u{1F3F4}${hidden}\u{E007F}`)

    expect(label).toContain('U+E0063')
    expect(label).not.toMatch(/[\u{E0000}-\u{E0FFF}]/u)
  })

  it.each([
    ['a Hangul filler', '\u3164', 'U+3164'],
    ['a blank Braille pattern', '\u2800', 'U+2800'],
    ['an interlinear annotation mark', '\uFFF9', 'U+FFF9'],
    ['an Egyptian format control', '\u{13430}', 'U+13430'],
  ])('is spelled out when %s sits in a name', (_what, character, named) => {
    expect(labelFor(`night${character}ly`)).toBe(`night${named}ly`)
  })

  it.each(OUTSIDE_THE_PRINT_SET)('is spelled out, not printed raw, by cronheart ping for %s', async (_what, name, named) => {
    const ran = await runCli(['ping', name], { env: envFor() })

    expect(ran.stderr).toContain(named)
    expect(ran.stderr).not.toMatch(UNPRINTED)
  })

  it.each(OUTSIDE_THE_PRINT_SET)('is spelled out in the monitor a ping result names, for %s', async (_what, name, named) => {
    const result = await createPingClient({ env: {}, fetch: createPingRecorder().fetch, onResult: () => {} }).ping(name)

    expect(result.monitor).toContain(named)
    expect(result.monitor).not.toMatch(UNPRINTED)
  })

  it.each(OUTSIDE_THE_PRINT_SET)('is spelled out in the wiring refusal for a monitors map keyed with %s', (_what, name, named) => {
    const refusal = (() => {
      try {
        createPingClient({ env: {}, fetch: createPingRecorder().fetch, monitors: { [name]: 'not-an-id' } })
      } catch (error) {
        return String(error)
      }

      return ''
    })()

    expect(refusal).toContain(named)
    expect(refusal).not.toMatch(UNPRINTED)
  })

  it('is refused by cronheart init when a character in it does not print, writing nothing and sending nothing', async () => {
    const path = join(workspace, '.env')
    const ran = await runCli(['init', '--name=night\u{E0041}ly', `--uuid=${MONITOR_ID}`, `--env-path=${path}`], { env: envFor() })

    expect(ran.status).toBe(64)
    expect(ran.stderr).toContain('U+E0041')
    expect(`${ran.stdout}${ran.stderr}`).not.toMatch(UNPRINTED)
    expect(() => readFileSync(path, 'utf8')).toThrow()
    expect(server.requests).toEqual([])
  })
})

describe('an ordinary name', () => {
  it.each([...ORDINARY, ...ORDINARY_LABELS_WITH_MANY_DIGITS])('is its own label and its own ping result monitor, for %s', async (_what, name) => {
    const result = await createPingClient({ env: {}, fetch: createPingRecorder().fetch, onResult: () => {} }).ping(name)

    expect(labelFor(name)).toBe(name)
    expect(result.monitor).toBe(name)
  })

  it.each(ORDINARY)('passes cronheart init and is printed as written, for %s', async (_what, name) => {
    const ran = await runCli(['init', `--name=${name}`, `--uuid=${MONITOR_ID}`, '--print-env'], { env: envFor() })

    expect(ran.stderr).toBe('')
    expect(ran.status).toBe(0)
    expect(ran.stdout).toContain(`run --name=${name} --`)
    expect(ran.stdout).toContain(`check-in for ${JSON.stringify(name)}`)
  })
})

describe('a name too long to cut', () => {
  it('settles the check-in rather than throwing out of ping(), at the size that overflowed an earlier run pattern', async () => {
    const pinged = createPingClient({ env: {}, fetch: createPingRecorder().fetch, onResult: () => {} }).ping('a'.repeat(4e6))

    await expect(pinged).resolves.toMatchObject({ ok: false })
  })
})

describe('command-line input echoed back in a refusal', () => {
  it.each([
    ['an unknown ping flag', ['ping', 'job', `--${ID}`]],
    ['a ping action', ['ping', 'job', `--action=${ID}`]],
    ['an unknown run flag', ['run', '--name=job', `--${ID}`, '--', 'true']],
    ['a run timeout', ['run', '--name=job', `--timeout=${ID}`, '--', 'true']],
    ['a redaction that does not compile', ['run', '--name=job', `--redact=(${ID}`, '--', 'true']],
    ['an unknown doctor flag', ['doctor', `--${ID}`]],
    ['an unknown sync flag', ['sync', `--${ID}`]],
    ['a sync configuration path', ['sync', `--config=/nonexistent/${ID}.json`]],
    ['an unknown signup flag', ['signup', `--${ID}`]],
    ['an unknown init flag', ['init', `--${ID}`, '--name=job', `--uuid=${MONITOR_ID}`, '--print-env']],
    ['a command run could not start', ['run', '--name=job', '--', `/nonexistent/${ID}/run.sh`]],
    ['an env file signup could not write', ['signup', 'someone@example.com', '--accept-terms', `--env-path=/nonexistent/${ID}/.env`]],
  ])('does not print the id in %s', async (_what, args) => {
    const ran = await runCli(args, { env: envFor() })

    expect(ran.stderr).not.toBe('')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it('does not print the id a ping address pasted as the base URL holds', async () => {
    const ran = await runCli(['ping', 'job'], {
      env: { ...envFor(), CRONHEART_URL: `http://cronheart.example/ping/${ID}`, CRONHEART_JOB_UUID: MONITOR_ID },
    })

    expect(ran.stdout + ran.stderr).toContain('cannot be a base URL')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it.each([
    ['as a string', ID],
    ['inside a list', [ID]],
    ['with tabs between the groups', ID.replaceAll('-', '\t')],
  ])('does not print the id a library caller passes as a check-in action %s', (_how, action) => {
    const refusal = (() => {
      try {
        createPingClient({ env: {}, fetch: createPingRecorder().fetch }).checkInWith('job', { action: action as never })
      } catch (error) {
        return String(error)
      }

      return ''
    })()

    expect(refusal).toContain('is not a check-in action')
    expect(holdsTheId(refusal)).toBe(false)
  })

  it('does not print the id doctor reads from the name of a configured variable', async () => {
    const variable = `CRONHEART_${ID.toUpperCase().replaceAll('-', '_')}_UUID`
    const ran = await runCli(['doctor', 'nothing-here'], { env: { ...envFor(), [variable]: MONITOR_ID } })

    expect(ran.stdout).toContain('id…')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it('leaves out of sync --print-env a monitor whose variable would hold another id', () => {
    const lines = envLinesFor([
      { name: `job ${ID}`, uuid: MONITOR_ID },
      { name: 'nightly', uuid: MONITOR_ID },
    ])

    expect(lines).toEqual([`CRONHEART_NIGHTLY_UUID=${MONITOR_ID}`])
  })
})

describe('a configuration path that holds an id', () => {
  it('is not printed whole in the error a failed load reports, Node\'s own message included', async () => {
    const directory = join(workspace, ID)
    mkdirSync(directory)
    const config = join(directory, 'cronheart.config.mjs')
    writeFileSync(config, "import 'no-such-package-here'\nexport default {}\n")

    const ran = await runCli(['sync', `--config=${config}`], { env: envFor() })

    expect(ran.stderr).toContain('could not be read')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })

  it('is not printed whole when no configuration is found in a directory named for one', async () => {
    const directory = join(workspace, ID)
    mkdirSync(directory)

    const ran = await runCli(['sync'], { env: envFor(), cwd: directory })

    expect(ran.stderr).toContain('no configuration file was named')
    expect(holdsTheId(`${ran.stdout}${ran.stderr}`)).toBe(false)
  })
})

describe('a name holding a long run of combining marks', () => {
  it('is labelled in linear time, not in the time a whole-string decomposition takes', () => {
    const started = Date.now()

    labelFor(`a${'\u0301'.repeat(80000)}${'\u0316'.repeat(80000)}`)

    expect(Date.now() - started).toBeLessThan(2000)
  })
})
