import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dist = new URL('../dist/', import.meta.url)

describe('package shape', () => {
  it('keeps node builtins out of every entry but the CLI, which is what makes edge runtimes viable', () => {
    const offenders = readdirSync(dist)
      .filter((name) => name.endsWith('.mjs') && name !== 'cli.mjs')
      .filter((name) => /["']node:/.test(readFileSync(new URL(name, dist), 'utf8')))

    expect(offenders).toEqual([])
  })

  it('ships an executable bin entry', () => {
    const cli = readFileSync(new URL('cli.mjs', dist), 'utf8')

    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true)
  })
})

describe('the negative control never ships', () => {
  it('is absent from every built entry, because it exists only to fail the matrix', () => {
    const offenders = readdirSync(dist)
      .filter((name) => name.endsWith('.mjs') || name.endsWith('.cjs') || name.endsWith('.ts'))
      .filter((name) => /__selftest__|unsafelyMonitored/.test(readFileSync(new URL(name, dist), 'utf8')))

    expect(offenders).toEqual([])
  })
})
