import { describe, expect, it, vi } from 'vitest'
import { createPingClient } from '../src/ping/client.js'
import { createPingRecorder } from '../src/testing.js'
import { clearWarnings } from '../src/ping/warn.js'
import { describePingResult, messageFor } from '../src/ping/describe.js'
import { envVarFor, labelFor, resolveMonitor } from '../src/ping/resolve.js'
import type { PingResult } from '../src/ping/types.js'

const ID = ['0a1b2c3d', '1111', '2222', '3333', '444455556666'].join('-')

const OTHER_ID = ['9a1b2c3d', '1111', '2222', '3333', 'aaaaaaaa6666'].join('-')

const COMPACT = ID.replaceAll('-', '')

const CUT = [
  ['an address', `https://ping.example/ping/${ID}`, 'id…6666'],
  ['a crontab line', `0 4 * * * curl -fsS https://ping.example/ping/${ID}`, 'id…6666'],
  ['a tenant name', `tenant ${ID}`, 'id…6666'],
  ['a compact id', `tenant ${COMPACT}`, 'id…6666'],
  ['non-breaking hyphens', `tenant ${ID.replaceAll('-', '‑')}`, 'id…6666'],
  ['en dashes', `tenant ${ID.replaceAll('-', '–')}`, 'id…6666'],
  ['an id written with other dashes', `tenant ${ID.replaceAll('-', '\u2212')}`, 'id…6666'],
  ['an id written with underscores', `tenant ${ID.replaceAll('-', '_')}`, 'id…6666'],
  ['an id with hex letters against it', `job1${ID}`, 'id…6666'],
  ['an id in upper case', `tenant ${ID.toUpperCase()}`, 'id…6666'],
  ['a zero-width space inside a group', `tenant ${ID.replace('-1111', '-11\u200B11')}`, 'id…6666'],
  ['a soft hyphen inside the first group', `tenant ${ID.replace('0a1b', '0a1b\u00AD')}`, 'id…6666'],
  ['a no-break space as one separator', `tenant ${ID.replace('-', '\u00A0')}`, 'id…6666'],
  ['a tab as one separator', `tenant ${ID.replace('-', '\t')}`, 'id…6666'],
  ['a zero-width space as one separator', `tenant ${ID.replace('-', '\u200B')}`, 'id…6666'],
  ['doubled dashes', `tenant ${ID.replaceAll('-', '--')}`, 'id…6666'],
  ['spaced dashes', `tenant ${ID.replaceAll('-', ' - ')}`, 'id…6666'],
  ['an emoji as a separator', `tenant ${ID.replace('-', '\u{1F525}')}`, 'id…6666'],
  ['a direction override elsewhere in the name', `night\u202E ${ID}`, 'id…6666'],
] as const

const KEPT = ['nightly-backup', 'db-2026-10-25', 'report-12345678', `tenant ${COMPACT.slice(1)}`, 'tenant 0a1b2c3d-1111']

describe('a name that carries a monitor id', () => {
  it.each(CUT)('is printed cut when it holds %s', (_what, name, label) => {
    expect(labelFor(name)).toBe(label)
    expect(resolveMonitor(name, {}, {}).label).toBe(label)
  })

  it.each(CUT)('never puts the id into the variable a diagnostic names, for %s', (_what, name) => {
    const { envVar } = resolveMonitor(name, {}, {})

    expect(envVar).toBe('CRONHEART_<NAME>_UUID')
  })

  it.each(CUT)('keeps no part of the id in the unset sentence for %s', (_what, name) => {
    const resolution = resolveMonitor(name, {}, {})
    const result = { monitor: resolution.label, outcome: 'suppressed', action: 'ping' } as unknown as PingResult
    const message = messageFor(result, resolution) ?? ''

    expect(resolution.reason).toBe('unset')
    expect(message).not.toMatch(/0a1b2c3d|444455556666/i)
    expect(describePingResult({ ...result, message })).not.toMatch(/0a1b2c3d|444455556666/i)
  })

  it('still reads the variable the whole name always screamed into, so a configured one keeps working', () => {
    const name = `tenant ${ID}`
    const env = { [envVarFor(name)]: '00000000-0000-0000-0000-000000000003' }

    expect(resolveMonitor(name, {}, env)).toMatchObject({
      id: '00000000-0000-0000-0000-000000000003',
      reason: 'ok',
    })
  })

  it('names no variable whatever separator the id was written with', () => {
    const name = `tenant ${ID.replaceAll('-', '\u2010')}`

    const resolution = resolveMonitor(name, {}, {})

    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
    expect(resolution.label).toBe('id…6666')
  })

  it('names no variable and shows one mark when an invisible character hides one of two ids', () => {
    const resolution = resolveMonitor(`a ${OTHER_ID} b ${ID.replace('0a1b', '0a1b\u00AD')}`, {}, {})

    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
    expect(resolution.label).toBe('id…6666')
  })

  it('names no variable when an upper-cased ligature stands in for part of the id', () => {
    const resolution = resolveMonitor(`tenant 0a1b2c3d ${'\uFB00'.repeat(16)} 1111-2222-3333-444455556666`, {}, {})

    expect(resolution.label).toBe('id…6666')
    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
  })

  it('names no variable when screaming the name hides the id it holds from the cut', () => {
    const resolution = resolveMonitor(`tenant ${ID.replace('-', '\u0131')}`, {}, {})

    expect(resolution.label).toBe('id…6666')
    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
  })

  it('names no variable for a name holding an id with an invisible character outside it', () => {
    const resolution = resolveMonitor(`back\u00ADup ${ID}`, {}, {})

    expect(resolution.envVar).toBe('CRONHEART_<NAME>_UUID')
    expect(resolution.label).toBe('id…6666')
  })

  it('cuts the id from the label of a name that is configured, which is the path that sends pings', () => {
    const name = `tenant ${ID}`
    const defined = { [name]: 'not-an-id' }
    const resolution = resolveMonitor(name, defined, {})
    const result = { monitor: resolution.label, outcome: 'suppressed', action: 'ping' } as unknown as PingResult

    expect(resolution.reason).toBe('malformed')
    expect(resolution.label).toBe('id…6666')
    expect(messageFor(result, resolution)).not.toMatch(/0a1b2c3d|444455556666/i)
  })

  it('warns once per monitor even when two names with ids end alike', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clearWarnings()
    const sdk = createPingClient({ env: {}, fetch: createPingRecorder().fetch })

    await sdk.ping(`tenant ${ID}`)
    await sdk.ping(`tenant ${OTHER_ID}`)

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('keys a warning on the name as given, so two ids that end alike are two monitors', () => {
    const one = resolveMonitor(`tenant ${ID}`, {}, {})
    const other = resolveMonitor(`tenant ${OTHER_ID}`, {}, {})

    expect(one.label).toBe(other.label)
    expect(one.key).not.toBe(other.key)
  })

  it.each(KEPT)('prints %s whole', (name) => {
    expect(labelFor(name)).toBe(name)
  })

  it('spells out an invisible character in a name that holds no id', () => {
    expect(labelFor('night\u200Bly')).toBe('nightU+200Bly')
  })
})
