import { readFileSync, readdirSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)
const pkg = JSON.parse(
  readFileSync(new URL('package.json', repoRoot), 'utf8'),
) as { version: string }

const versionLiteral = JSON.stringify(pkg.version)

function filesUnder(dir: URL, extension: string): URL[] {
  return readdirSync(dir).flatMap((name) => {
    const child = new URL(name, dir)

    if (statSync(child).isDirectory()) {
      return filesUnder(new URL(`${name}/`, dir), extension)
    }

    return name.endsWith(extension) ? [child] : []
  })
}

function literalCount(files: URL[]): number {
  return files.reduce(
    (total, file) => total + readFileSync(file, 'utf8').split(versionLiteral).length - 1,
    0,
  )
}

describe('version single-sourcing', () => {
  it('is absent from src, so the build is the only place it can come from', () => {
    const offenders = filesUnder(new URL('src/', repoRoot), '.ts').filter((file) =>
      readFileSync(file, 'utf8').includes(pkg.version),
    )

    expect(offenders.map((file) => file.pathname.split('/src/')[1])).toEqual([])
  })

  it('is injected into exactly one place per build format', () => {
    const dist = new URL('dist/', repoRoot)

    expect(literalCount(filesUnder(dist, '.mjs'))).toBe(1)
    expect(literalCount(filesUnder(dist, '.cjs'))).toBe(1)
  })

  it('reaches the User-Agent of the built artifact', async () => {
    const built = (await import(new URL('dist/index.mjs', repoRoot).href)) as {
      SDK_VERSION: string
      userAgent: () => string
    }

    expect(built.SDK_VERSION).toBe(pkg.version)
    expect(built.userAgent()).toBe(
      `cronheart-node/${pkg.version} node/${process.versions.node}`,
    )
  })
})
