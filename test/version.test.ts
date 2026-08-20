import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { wholeGraph } from './support/module-graph.js'

const repoRoot = new URL('../', import.meta.url)
const pkg = JSON.parse(
  readFileSync(new URL('package.json', repoRoot), 'utf8'),
) as { version: string }
const contract = JSON.parse(
  readFileSync(new URL('contract/cronheart-contract.json', repoRoot), 'utf8'),
) as { contract_version: string }

const injectedVersions = [pkg.version, contract.contract_version]

function filesUnder(dir: URL, extension: string): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const child = new URL(name, dir)

    if (statSync(child).isDirectory()) {
      return filesUnder(new URL(`${name}/`, dir), extension)
    }

    return name.endsWith(extension) ? [child] : []
  })
}

function literalCount(files: URL[], version: string): number {
  const literal = JSON.stringify(version)

  return files.reduce(
    (total, file) => total + readFileSync(file, 'utf8').split(literal).length - 1,
    0,
  )
}

describe('version single-sourcing', () => {
  it('is absent from src, so the build is the only place it can come from', () => {
    const sources = filesUnder(new URL('src/', repoRoot), '.ts')
    const offenders = sources.filter((file) => {
      const source = readFileSync(file, 'utf8')

      return injectedVersions.some((version) => source.includes(version))
    })

    expect(sources.length).toBeGreaterThan(0)
    expect(offenders.map((file) => file.pathname.split('/src/')[1])).toEqual([])
  })

  // The CLI is bundled apart from the library entries so that it cannot pull the ping path
  // into a shared chunk, which makes it a third artifact rather than a third format.
  it('is injected into exactly one place per built artifact', () => {
    const dist = new URL('dist/', repoRoot)
    const cliFiles = new Set(wholeGraph(dist, 'cli.mjs').names)
    const belongsToCli = (file: URL): boolean =>
      cliFiles.has(String(file.pathname.split('/').pop()))
    const esm = filesUnder(dist, '.mjs')
    const artifacts = [
      esm.filter((file) => !belongsToCli(file)),
      esm.filter(belongsToCli),
      filesUnder(dist, '.cjs'),
    ]

    expect(artifacts.map((files) => files.length > 0)).toEqual([true, true, true])

    for (const version of injectedVersions) {
      expect(artifacts.map((files) => literalCount(files, version))).toEqual([1, 1, 1])
    }
  })

  it('reaches the User-Agent of the built artifact', async () => {
    const built = (await import(new URL('dist/index.mjs', repoRoot).href)) as {
      SDK_VERSION: string
      CONTRACT_VERSION: string
      userAgent: () => string
    }

    expect(built.SDK_VERSION).toBe(pkg.version)
    expect(built.CONTRACT_VERSION).toBe(contract.contract_version)
    expect(built.userAgent()).toBe(
      `cronheart-node/${pkg.version} contract/${contract.contract_version} node/${process.versions.node}`,
    )
  })
})
