import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
    const offenders = filesUnder(new URL('src/', repoRoot), '.ts').filter((file) => {
      const source = readFileSync(file, 'utf8')

      return injectedVersions.some((version) => source.includes(version))
    })

    expect(offenders.map((file) => file.pathname.split('/src/')[1])).toEqual([])
  })

  it('is injected into exactly one place per build format', () => {
    const dist = new URL('dist/', repoRoot)
    const esm = filesUnder(dist, '.mjs')
    const cjs = filesUnder(dist, '.cjs')

    for (const version of injectedVersions) {
      expect(literalCount(esm, version)).toBe(1)
      expect(literalCount(cjs, version)).toBe(1)
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
