import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCli } from './support/cli.js'
import { wholeGraph } from './support/module-graph.js'

const repoRoot = new URL('../', import.meta.url)
const pkg = JSON.parse(
  readFileSync(new URL('package.json', repoRoot), 'utf8'),
) as { name: string; version: string }
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

  // The command-line tool and the management client are each bundled apart from the library
  // entries so that neither can pull the check-in path into a shared chunk. That makes them
  // artifacts in their own right rather than further formats, and each carries its own copy.
  it('is injected into exactly one place per built artifact', () => {
    const dist = new URL('dist/', repoRoot)
    const nameOf = (file: URL): string => String(file.pathname.split('/').pop())
    const graphs = {
      cli: new Set(wholeGraph(dist, 'cli.mjs').names),
      apiEsm: new Set(wholeGraph(dist, 'api.mjs').names),
      apiCjs: new Set(wholeGraph(dist, 'api.cjs').names),
    }
    const esm = filesUnder(dist, '.mjs')
    const cjs = filesUnder(dist, '.cjs')
    const artifacts = [
      esm.filter((file) => !graphs.cli.has(nameOf(file)) && !graphs.apiEsm.has(nameOf(file))),
      esm.filter((file) => graphs.apiEsm.has(nameOf(file))),
      esm.filter((file) => graphs.cli.has(nameOf(file))),
      cjs.filter((file) => !graphs.apiCjs.has(nameOf(file))),
      cjs.filter((file) => graphs.apiCjs.has(nameOf(file))),
    ]
    const one = artifacts.map(() => 1)

    expect(artifacts.map((files) => files.length > 0)).toEqual(artifacts.map(() => true))

    for (const version of injectedVersions) {
      expect(artifacts.map((files) => literalCount(files, version))).toEqual(one)
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

describe('what --version names', () => {
  it('is the package a reader can install, not the repository it is built from', async () => {
    const ran = await runCli(['--version'])

    expect(pkg.name).not.toContain('-node')
    expect(ran.stdout.trim()).toBe(
      `${pkg.name} ${pkg.version} (contract ${contract.contract_version})`,
    )
  })

  it('keeps the language in the User-Agent, where a server log needs to tell the SDKs apart', async () => {
    const built = (await import(new URL('dist/index.mjs', repoRoot).href)) as {
      userAgent: () => string
    }

    expect(built.userAgent()).toContain('cronheart-node/')
  })
})
