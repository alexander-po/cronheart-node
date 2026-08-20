import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wholeGraph } from './support/module-graph.js'

const dist = new URL('../dist/', import.meta.url)

const NODE_BUILTIN = /["']node:/

const { exports: exportsMap } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> }

const RUNTIME_ENTRIES = [
  ...new Set(
    Object.values(exportsMap)
      .flatMap((target) => [
        (target as { import?: { default?: unknown } }).import?.default,
        (target as { require?: { default?: unknown } }).require?.default,
      ])
      .filter((file): file is string => typeof file === 'string')
      .map((file) => file.replace('./dist/', '')),
  ),
]

function usesNodeBuiltins(names: readonly string[]): string[] {
  return names.filter((name) => NODE_BUILTIN.test(readFileSync(new URL(name, dist), 'utf8')))
}

describe('package shape', () => {
  it('resolves every published entry from the exports map, in both module formats', () => {
    expect(RUNTIME_ENTRIES).toContain('index.mjs')
    expect(RUNTIME_ENTRIES).toContain('index.cjs')
    expect(RUNTIME_ENTRIES.length).toBeGreaterThan(10)
  })

  it('keeps node builtins out of every published entry and every chunk it reaches', () => {
    const reached = RUNTIME_ENTRIES.flatMap((entry) => wholeGraph(dist, entry).names)

    expect(reached.length).toBeGreaterThan(RUNTIME_ENTRIES.length)
    expect(usesNodeBuiltins([...new Set(reached)])).toEqual([])
  })

  it('detects a node builtin when there is one to detect, so the check above is not vacuous', () => {
    expect(usesNodeBuiltins(wholeGraph(dist, 'cli.mjs').names).length).toBeGreaterThan(0)
  })

  it('leaves nothing runnable in the tarball that no entry point reaches', () => {
    const reached = new Set([
      ...RUNTIME_ENTRIES.flatMap((entry) => wholeGraph(dist, entry).names),
      ...wholeGraph(dist, 'cli.mjs').names,
    ])

    expect(
      readdirSync(dist).filter((name) => /\.(mjs|cjs)$/.test(name) && !reached.has(name)),
    ).toEqual([])
  })

  it('ships an executable bin entry', () => {
    const cli = readFileSync(new URL('cli.mjs', dist), 'utf8')

    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true)
  })
})

describe('the negative control never ships', () => {
  it('is absent from every built file, declarations included, because it exists only to fail the matrix', () => {
    const built = readdirSync(dist).map((name) => ({
      name,
      source: readFileSync(new URL(name, dist), 'utf8'),
    }))

    expect(built.map(({ name }) => name)).toContain('index.d.mts')
    expect(
      built
        .filter(({ source }) => /__selftest__|unsafelyMonitored|unsafelyManaged/.test(source))
        .map(({ name }) => name),
    ).toEqual([])
  })
})
