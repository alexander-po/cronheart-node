import { readFileSync } from 'node:fs'

const DYNAMIC = /\bimport\(\s*["'](\.\/[^"']+)["']\s*\)/g

const RE_EXPORT = /\bfrom\s*["'](\.\/[^"']+)["']/g

const SIDE_EFFECT = /(?:^|[;\n])\s*import\s*["'](\.\/[^"']+)["']/g

const REQUIRE = /\brequire\(\s*["'](\.\/[^"']+)["']\s*\)/g

export interface Edges {
  readonly source: string
  readonly statics: readonly string[]
  readonly dynamics: readonly string[]
}

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map(([, specifier]) => String(specifier))
}

export function edgesOf(dist: URL, name: string): Edges {
  const source = readFileSync(new URL(name, dist), 'utf8')
  const dynamics = matches(source, DYNAMIC)
  const dynamic = new Set(dynamics)
  const statics = [
    ...matches(source, RE_EXPORT),
    ...matches(source, SIDE_EFFECT),
    ...matches(source, REQUIRE),
  ].filter(
    (specifier) => !dynamic.has(specifier),
  )

  return { source, statics: [...new Set(statics)], dynamics: [...new Set(dynamics)] }
}

export interface Graph {
  readonly names: readonly string[]
  readonly source: string
  readonly dynamics: readonly string[]
}

function bare(specifier: string): string {
  return specifier.replace(/^\.\//, '')
}

export function staticGraph(dist: URL, entry: string): Graph {
  const seen = new Map<string, string>()
  const dynamics = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const name = queue.shift() ?? ''

    if (seen.has(name)) {
      continue
    }

    const edges = edgesOf(dist, name)
    seen.set(name, edges.source)

    for (const specifier of edges.dynamics) {
      dynamics.add(bare(specifier))
    }

    for (const specifier of edges.statics) {
      queue.push(bare(specifier))
    }
  }

  return {
    names: [...seen.keys()],
    source: [...seen.values()].join('\n'),
    dynamics: [...dynamics],
  }
}

export function wholeGraph(dist: URL, entry: string): Graph {
  const collected = new Set<string>()
  const sources: string[] = []
  const queue = [entry]

  while (queue.length > 0) {
    const name = queue.shift() ?? ''

    if (collected.has(name)) {
      continue
    }

    const edges = edgesOf(dist, name)
    collected.add(name)
    sources.push(edges.source)

    for (const specifier of [...edges.statics, ...edges.dynamics]) {
      queue.push(bare(specifier))
    }
  }

  return { names: [...collected], source: sources.join('\n'), dynamics: [] }
}
