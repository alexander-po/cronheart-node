import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Rolldown } from 'tsdown'

// The ceiling is on the minified figure because that is the one a consumer receives: their
// bundler minifies, so bounding the unminified bytes bounded a file nobody downloads.
const BUDGET_GZIP_BYTES = 7168

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

async function minify(entry) {
  const bundle = await Rolldown.rolldown({
    input: fileURLToPath(entry),
    platform: 'neutral',
    logLevel: 'silent',
  })

  try {
    const { output } = await bundle.generate({ format: 'esm', minify: true })

    return output
      .filter((chunk) => chunk.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n')
  } finally {
    await bundle.close()
  }
}

function gzippedBytes(source) {
  return gzipSync(Buffer.from(source), { level: 9 }).byteLength
}

const entry = new URL('../dist/index.mjs', import.meta.url)
const modules = reachableFrom(entry)
const unminified = gzippedBytes(modules.join('\n'))
const minified = gzippedBytes(await minify(entry))
const withinBudget = minified <= BUDGET_GZIP_BYTES

process.stdout.write(
  `ping entry (${modules.length} module(s)) — ${minified} B minified+gzipped (budget ${BUDGET_GZIP_BYTES} B), ${unminified} B gzipped unminified — ${withinBudget ? 'ok' : 'OVER BUDGET'}\n`,
)

if (!withinBudget) {
  process.exit(1)
}
