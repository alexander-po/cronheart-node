import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { PEERS_BY_SUBPATH, floorOf } from '../scripts/min-peers.mjs'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  exports: Readonly<Record<string, unknown>>
  peerDependencies: Readonly<Record<string, string>>
}

const dist = new URL('../dist/', import.meta.url)

const map = PEERS_BY_SUBPATH as Readonly<Record<string, readonly string[]>>

// A subpath ships an adapter once its built entry has something callable in it. Reading the
// build rather than a list here is what stops the floor run quietly skipping the next
// adapter someone adds: the entry appears, and this fails until its peer floor is named.
function adapterSubpaths(): string[] {
  const built = new Set(readdirSync(dist))

  return Object.entries(manifest.exports)
    .filter(([subpath]) => subpath !== '.' && subpath !== './package.json')
    .filter(([, target]) => {
      const file = (target as { import?: { default?: unknown } }).import?.default

      if (typeof file !== 'string') {
        return false
      }

      const name = file.replace('./dist/', '')

      return built.has(name) && /\bexport\s*\{[^}]*\w/.test(readFileSync(new URL(name, dist), 'utf8'))
    })
    .map(([subpath]) => subpath)
    .filter((subpath) => !['./api', './sync', './testing'].includes(subpath))
}

describe('the minimum-peer floor run', () => {
  it('names a peer floor for every adapter subpath that ships something', () => {
    const shipped = adapterSubpaths()

    expect(shipped.length).toBeGreaterThan(0)
    expect(shipped.filter((subpath) => map[subpath] === undefined)).toEqual([])
  })

  it('installs only packages the manifest actually declares as peers', () => {
    const named = [...new Set(Object.values(map).flat())]

    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((name) => manifest.peerDependencies[name] === undefined)).toEqual([])
  })

  it('reads the floor of a range as its first clause, not its last', () => {
    expect(floorOf('^9.0.0 || ^10.0.0')).toBe('9.0.0')
    expect(floorOf('^4.4.0')).toBe('4.4.0')
    expect(floorOf('>=2.1.0')).toBe('2.1.0')
    expect(() => floorOf('latest')).toThrow(/floor/)
  })

  it('resolves every declared range to a floor the run can install', () => {
    for (const name of new Set(Object.values(map).flat())) {
      expect(floorOf(manifest.peerDependencies[name] as string)).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
