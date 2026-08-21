import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { wholeGraph } from './support/module-graph.js'

const dist = new URL('../dist/', import.meta.url)

const CLI_SUBPATH = './cli'

const NODE_BUILTIN = /["']node:/

const { exports: exportsMap } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { exports: Record<string, unknown> }

// The command-line tool is the one entry allowed to reach Node built-ins. Naming it keeps
// the exemption visible rather than resting on the shape its export target happens to take.
const RUNTIME_ENTRIES = [
  ...new Set(
    Object.entries(exportsMap)
      .filter(([subpath]) => subpath !== CLI_SUBPATH)
      .flatMap(([, target]) => [
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

describe('the command-line tool is reachable by a specifier, not only by a global install', () => {
  it('publishes a subpath for it, so an image build can resolve and copy it', () => {
    const target = exportsMap[CLI_SUBPATH]

    expect(typeof target).toBe('string')
    expect(readFileSync(new URL(String(target).replace('./dist/', ''), dist), 'utf8')).toContain(
      '#!/usr/bin/env node',
    )
  })

  it('does not take over a process that imported it rather than launching it', () => {
    const imported = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(new URL('cli.mjs', dist).href)});console.log('SURVIVED')`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

    expect(imported).toContain('SURVIVED')
  })

  it('still runs when it is the process entry, which is the whole of what bin means', () => {
    const launched = execFileSync(process.execPath, [new URL('cli.mjs', dist).pathname, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(launched).toContain('(contract ')
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
