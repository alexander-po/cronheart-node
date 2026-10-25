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
  ['an address', `https://ping.example/ping/${ID}`, 'https://ping.example/ping/id…6666'],
  ['a crontab line', `0 4 * * * curl -fsS https://ping.example/ping/${ID}`, '0 4 * * * curl -fsS https://ping.example/ping/id…6666'],
  ['a tenant name', `tenant ${ID}`, 'tenant id…6666'],
  ['a compact id', `tenant ${COMPACT}`, 'tenant id…6666'],
  ['non-breaking hyphens', `tenant ${ID.replaceAll('-', '‑')}`, 'tenant id…6666'],
  ['en dashes', `tenant ${ID.replaceAll('-', '–')}`, 'tenant id…6666'],
  ['an id written with other dashes', `tenant ${ID.replaceAll('-', '\u2212')}`, 'tenant id…6666'],
  ['an id written with underscores', `tenant ${ID.replaceAll('-', '_')}`, 'tenant id…6666'],
  ['an id with hex letters against it', `job1${ID}`, 'job1id…6666'],
  ['an id in upper case', `tenant ${ID.toUpperCase()}`, 'tenant id…6666'],
] as const

const KEPT = ['nightly-backup', 'db-2026-10-25', 'report-12345678', `tenant ${COMPACT.slice(1)}`, 'tenant 0a1b2c3d-1111']

describe('a name that carries a monitor id', () => {
  it.each(CUT)('is printed cut when it holds %s', (_what, name, label) => {
    expect(labelFor(name)).toBe(label)
    expect(resolveMonitor(name, {}, {}).label).toBe(label)
  })

  it.each(CUT)('never puts the id into the variable a diagnostic names, for %s', (_what, name) => {
    const { envVar } = resolveMonitor(name, {}, {})

    expect(envVar).toMatch(/^CRONHEART_.*<ID>/)
    expect(envVar).not.toMatch(/0A1B2C3D|444455556666/)
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

  it('cuts the id from the variable whatever separator it was written with', () => {
    const name = `tenant ${ID.replaceAll('-', '\u2010')}`

    const resolution = resolveMonitor(name, {}, {})

    expect(resolution.envVar).toBe('CRONHEART_TENANT_<ID>_UUID')
    expect(resolution.label).toBe('tenant id…6666')
  })

  it('cuts the id from the label of a name that is configured, which is the path that sends pings', () => {
    const name = `tenant ${ID}`
    const defined = { [name]: 'not-an-id' }
    const resolution = resolveMonitor(name, defined, {})
    const result = { monitor: resolution.label, outcome: 'suppressed', action: 'ping' } as unknown as PingResult

    expect(resolution.reason).toBe('malformed')
    expect(resolution.label).toBe('tenant id…6666')
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
})
