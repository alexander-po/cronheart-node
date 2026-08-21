import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The npm equivalent of a dependency-floor run. An adapter is typed against a peer it never
// imports at runtime, so nothing in the ordinary gate ever compiles it against the oldest
// version its range claims — and a range is a promise until something checks it. Every
// package here is installed at the lowest version its declared range admits, on the Node
// floor, and the whole adapter slice is compiled and run against that.
export const PEERS_BY_SUBPATH = {
  './croner': ['croner'],
  './cron': ['cron'],
  './node-cron': ['node-cron'],
  './node-schedule': ['node-schedule'],
  './bullmq': ['bullmq'],
  './nestjs': ['@nestjs/schedule', '@nestjs/common'],
}

// Packages that are peers of a peer rather than of ours, and that a framework releasing its
// halves in lockstep will not load without: pinning one half to its floor and leaving the
// other at head produces a graph whose failure reads as the adapter's rather than the run's.
export const COMPANIONS_BY_PEER = {
  '@nestjs/common': ['@nestjs/core'],
}

const rootPath = new URL('../package.json', import.meta.url)

const fixturePath = new URL('../test/fixture-consumer/package.json', import.meta.url)

const lockPath = new URL('../pnpm-lock.yaml', import.meta.url)

const CHECKS = [
  ['pnpm', 'run', 'build'],
  ['pnpm', 'run', 'typecheck'],
  ['pnpm', 'run', 'typecheck:fixture'],
  [
    'pnpm',
    'vitest',
    'run',
    'test/adapter-croner.test.ts',
    'test/adapter-cron.test.ts',
    'test/adapter-node-cron.test.ts',
    'test/adapter-node-schedule.test.ts',
    'test/adapter-bullmq.test.ts',
    'test/adapter-nestjs.test.ts',
    'test/fault-matrix.test.ts',
  ],
]

// The first clause of a range is its floor: '^9.0.0 || ^10.0.0' promises 9.0.0 works, and
// that is the promise nothing else in the repository tests.
export function floorOf(range) {
  const first = String(range).split('||')[0].trim()
  const version = first.replace(/^[\^~>=\s]+/, '')

  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`cannot read a floor version out of the range ${JSON.stringify(range)}`)
  }

  return version
}

export function floors(peerDependencies) {
  const wanted = [...new Set(Object.values(PEERS_BY_SUBPATH).flat())].sort()

  return wanted.map((name) => {
    const range = peerDependencies[name]

    if (range === undefined) {
      throw new Error(`${name} is installed at its floor but declared as a peer of nothing`)
    }

    return `${name}@${floorOf(range)}`
  })
}

export function withCompanions(pinned) {
  const alongside = pinned.flatMap((entry) => {
    const at = entry.lastIndexOf('@')

    return (COMPANIONS_BY_PEER[entry.slice(0, at)] ?? []).map(
      (companion) => `${companion}@${entry.slice(at + 1)}`,
    )
  })

  return [...pinned, ...alongside]
}

function run(command) {
  const [file, ...args] = command
  const result = spawnSync(file, args, { stdio: 'inherit', cwd: fileURLToPath(new URL('../', import.meta.url)) })

  return result.status === 0
}

function main() {
  const originals = [rootPath, fixturePath, lockPath].map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }))
  const root = JSON.parse(originals[0].source)
  const fixture = JSON.parse(originals[1].source)
  const pinned = withCompanions(floors(root.peerDependencies ?? {}))

  process.stdout.write(`min-peers — installing ${pinned.join(', ')}\n`)

  for (const entry of pinned) {
    const at = entry.lastIndexOf('@')
    const name = entry.slice(0, at)
    const version = entry.slice(at + 1)

    if (root.devDependencies?.[name] !== undefined) {
      root.devDependencies[name] = version
    }

    if (fixture.devDependencies?.[name] !== undefined) {
      fixture.devDependencies[name] = version
    }
  }

  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`)
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)

  let ok = run(['pnpm', 'install', '--no-frozen-lockfile'])

  for (const check of CHECKS) {
    if (!ok) {
      break
    }

    ok = run(check)
  }

  for (const { path, source } of originals) {
    writeFileSync(path, source)
  }

  run(['pnpm', 'install', '--frozen-lockfile'])

  process.stdout.write(`min-peers — ${ok ? 'ok' : 'FAILED'} against ${pinned.join(', ')}\n`)

  if (!ok) {
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
