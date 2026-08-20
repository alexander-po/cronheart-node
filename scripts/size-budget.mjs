import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_GZIP_BYTES = 8704

const RELATIVE_SPECIFIER = /["'](\.\/[^"']+\.m?js)["']/g

function reachableFrom(entry) {
  const modules = new Map()
  const queue = [entry]

  while (queue.length > 0) {
    const current = queue.shift()

    if (modules.has(current.href)) {
      continue
    }

    const source = readFileSync(current, 'utf8')
    modules.set(current.href, source)

    for (const [, specifier] of source.matchAll(RELATIVE_SPECIFIER)) {
      queue.push(new URL(specifier, current))
    }
  }

  return [...modules.values()]
}

const entry = new URL('../dist/index.mjs', import.meta.url)
const modules = reachableFrom(entry)
const gzipped = gzipSync(Buffer.from(modules.join('\n')), { level: 9 }).byteLength
const withinBudget = gzipped <= BUDGET_GZIP_BYTES

process.stdout.write(
  `ping entry (${modules.length} module(s)) — ${gzipped} B gzipped, budget ${BUDGET_GZIP_BYTES} B — ${withinBudget ? 'ok' : 'OVER BUDGET'}\n`,
)

if (!withinBudget) {
  process.exit(1)
}
