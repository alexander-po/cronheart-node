import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dist = new URL('../dist/', import.meta.url)

function contentsOf(names: readonly string[]): { name: string; source: string }[] {
  return names.map((name) => ({ name, source: readFileSync(new URL(name, dist), 'utf8') }))
}

describe('package shape', () => {
  it('keeps node builtins out of every entry but the CLI, which is what makes edge runtimes viable', () => {
    const runtime = contentsOf(
      readdirSync(dist).filter((name) => name.endsWith('.mjs') && name !== 'cli.mjs'),
    )

    expect(runtime.length).toBeGreaterThan(0)
    expect(runtime.filter(({ source }) => /["']node:/.test(source)).map(({ name }) => name)).toEqual(
      [],
    )
  })

  it('ships an executable bin entry', () => {
    const cli = readFileSync(new URL('cli.mjs', dist), 'utf8')

    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true)
  })
})

describe('the negative control never ships', () => {
  it('is absent from every built file, declarations included, because it exists only to fail the matrix', () => {
    const built = contentsOf(readdirSync(dist))

    expect(built.map(({ name }) => name)).toContain('index.d.mts')
    expect(
      built
        .filter(({ source }) => /__selftest__|unsafelyMonitored/.test(source))
        .map(({ name }) => name),
    ).toEqual([])
  })
})
