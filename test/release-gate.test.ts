import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The scan's own rules, not a copy of them: a second copy is how the two stop agreeing.
// @ts-expect-error — a build script, checked by the guard rather than by tsc
import { isScanned, scanTarball, scanTree, unreadOf } from '../scripts/private-information.mjs'

interface Scan {
  readonly files: readonly string[]
  readonly read: number
  readonly unreadable: readonly string[]
}

const scanOf = scanTree as (tree: string) => Scan
const scanPacked = scanTarball as (tarball: string, workspace: string) => Scan
const scans = isScanned as (path: string) => boolean
const unreadIn = unreadOf as (listed: readonly string[], scan: Pick<Scan, 'files'>) => string[]

const root = fileURLToPath(new URL('../', import.meta.url))

interface Run {
  readonly status: number | null
  readonly output: string
}

function check(script: string, ...args: readonly string[]): Run {
  const ran = spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 900_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
  })

  return { status: ran.status, output: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
}

function problemsIn(output: string): string[] {
  return [...output.matchAll(/^ {2}- (.+)$/gm)].map((match) => match[1] as string)
}

const UNCONSUMED = /^\.changeset\/\S+ — is unconsumed \(/

// A scan that read nothing says the same about a tree as one that read all of it, so what
// it reached is asserted rather than taken from the absence of findings.
function filesReadIn(output: string): number {
  return Number(/(\d+) file\(s\) read/.exec(output)?.[1] ?? -1)
}

// Every file git can see includes the installed dependencies, which outgrow the default buffer.
const GIT_OUTPUT_BYTES = 64 * 1024 * 1024

function git(tree: string, ...args: readonly string[]): string {
  const ran = spawnSync('git', args, { cwd: tree, encoding: 'utf8', maxBuffer: GIT_OUTPUT_BYTES })

  if (ran.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${tree}: ${ran.error?.message ?? ran.stderr}`)
  }

  return ran.stdout
}

// Every file git can see, tracked or not and ignored or not, held to the scan's own rules.
// Git is what keeps the list independent of the walk it checks: a checkout parked over a
// directory of this tree hides that directory from the walk and not from git's index, where
// a floor picked by hand would leave slack enough to hide it. A path git ends with a slash
// is a checkout of its own, which the scan does not read either.
function filesTheScanIsOwed(tree: string): string[] {
  return git(tree, 'ls-files', '-z', '--cached', '--others')
    .split('\0')
    .filter(
      (path) =>
        path !== '' &&
        !path.endsWith('/') &&
        scans(path) &&
        // Tracked and deleted is still tracked, and a version run deletes the changesets it
        // consumed: the scan walks what is on disk, so that is what it is owed.
        existsSync(join(tree, path)),
    )
    .sort()
}

// Written out rather than taken from the scan: the rules above are the scan's own, so this is
// what notices one of them growing over a file the repository tracks.
const TRACKED_TREES_THE_SCAN_SKIPS = ['test/fixtures/private-information/', 'test/fixtures/release-metadata/']

function trackedFilesTheScanSkips(tree: string): string[] {
  return git(tree, 'ls-files', '-z', '--cached')
    .split('\0')
    .filter((path) => path !== '' && existsSync(join(tree, path)) && !scans(path))
    .sort()
}

function trackedFilesUnder(tree: string, trees: readonly string[]): string[] {
  return git(tree, 'ls-files', '-z', '--cached')
    .split('\0')
    .filter((path) => trees.some((under) => path.startsWith(under)) && existsSync(join(tree, path)))
    .sort()
}

function filesScannedIn(tree: string): string[] {
  return [...scanOf(tree).files].sort()
}

function writeUnder(tree: string, path: string, text = 'nothing to see here\n'): void {
  mkdirSync(dirname(join(tree, path)), { recursive: true })
  writeFileSync(join(tree, path), text)
}

// Read out of the fixture rather than written here, since a line carrying one of them is a
// disclosure wherever it sits. A report is read in a gate log, so it must not repeat them.
function plantedIn(tree: string): string[] {
  const text = ['credentials.md', 'notes.md']
    .map((name) => readFileSync(join(root, tree, name), 'utf8'))
    .join('\n')

  return [
    /\bghp_\w+/.exec(text)?.[0],
    /"(\w{24,})"/.exec(text)?.[1],
    /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/.exec(text)?.[0],
  ].filter((value): value is string => value !== undefined)
}

function disclosureIdsIn(output: string): string[] {
  return [...new Set([...output.matchAll(/^ {2}- ([a-z-]+):/gm)].map((match) => match[1] as string))].sort()
}

describe('the documented surface is held against the built one', () => {
  it(
    'passes a document that still describes the package',
    () => {
      const run = check('doc-claims', 'test/fixtures/doc-claims/clean')

      expect(run.output).toContain('compiled sample(s)')
      expect(problemsIn(run.output)).toEqual([])
      expect(run.status).toBe(0)
    },
    900_000,
  )

  it(
    'catches a sample that no longer compiles, a flag no command takes, a command that is gone, a variable nothing reads, a recipe that does not exist and a command the agent recipe names',
    () => {
      const run = check('doc-claims', 'test/fixtures/doc-claims/dirty')
      const problems = problemsIn(run.output).join('\n')

      expect(run.status).toBe(1)
      expect(problems).toContain("'actoin' does not exist")
      expect(problems).toContain('--quietly is documented and no cronheart command takes it')
      expect(problems).toContain('cronheart has no reconcile command')
      expect(problems).toContain('skills/add-cronheart/SKILL.md:6 — cronheart has no enrol command')
      expect(problems).toContain('CRONHEART_MONITOR_TOKEN is documented and nothing under src reads it')
      expect(problems).toContain('the Makefile has no audit-everything target')
    },
    900_000,
  )

  it('holds the shipped documents to the same reading', () => {
    const run = check('doc-claims')

    expect(problemsIn(run.output)).toEqual([])
    expect(run.status).toBe(0)
  }, 900_000)
})

describe('the generic half of the leak control', () => {
  it('passes a tree that gives nothing away', () => {
    const run = check('private-information', 'test/fixtures/private-information/clean')

    expect(disclosureIdsIn(run.output)).toEqual([])
    expect(run.output).toContain('none of the shapes this scan knows')
    expect(run.status).toBe(0)
  })

  it('catches every shape it knows, one file per shape', () => {
    const run = check('private-information', 'test/fixtures/private-information/dirty')

    expect(run.status).toBe(1)
    expect(filesReadIn(run.output)).toBe(3)
    expect(disclosureIdsIn(run.output)).toEqual([
      'another-repository',
      'assigned-secret',
      'developer-path',
      'issued-credential',
      'live-identifier',
      'php-file-reference',
      'php-namespace',
      'reachable-address',
      'routable-address',
      'vendor-token',
    ])
    expect(plantedIn('test/fixtures/private-information/dirty')).toHaveLength(3)

    for (const value of plantedIn('test/fixtures/private-information/dirty')) {
      expect(run.output).not.toContain(value)
    }
  })

  it('holds the repository itself to the same reading, over a tree it is shown to have read', () => {
    const run = check('private-information', '.')
    const owed = filesTheScanIsOwed(root)

    expect(disclosureIdsIn(run.output)).toEqual([])
    expect(run.status).toBe(0)
    expect(filesScannedIn(root)).toEqual(owed)
    expect(filesReadIn(run.output)).toBe(owed.length)
    expect(trackedFilesTheScanSkips(root)).toEqual(
      trackedFilesUnder(root, TRACKED_TREES_THE_SCAN_SKIPS),
    )
  })

  it('is owed every file it walks, including the ones git is told to ignore', () => {
    const tree = mkdtempSync(join(tmpdir(), 'leak-scan-owed-'))

    try {
      writeUnder(tree, '.gitignore', '.env\n.idea/\ndist/\nnode_modules/\n')
      writeUnder(tree, 'notes.md')
      writeUnder(tree, '.env', 'EXAMPLE=1\n')
      writeUnder(tree, '.idea/workspace.xml')
      writeUnder(tree, 'package/dist/bundle.js')
      writeUnder(tree, 'dist/bundle.js')
      writeUnder(tree, 'node_modules/dependency/index.js')
      writeUnder(tree, 'logo.png')
      writeUnder(tree, 'lib/coverage/report.md')
      git(tree, 'init', '--quiet')
      git(tree, 'add', '.gitignore', 'notes.md', 'lib/coverage/report.md')

      expect(filesTheScanIsOwed(tree)).toEqual([
        '.env',
        '.gitignore',
        '.idea/workspace.xml',
        'notes.md',
        'package/dist/bundle.js',
      ])
      expect(filesScannedIn(tree)).toEqual(filesTheScanIsOwed(tree))
      expect(trackedFilesTheScanSkips(tree)).toEqual(['lib/coverage/report.md'])
    } finally {
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('counts what it read rather than what it listed, and fails on a file it could not read', () => {
    const tree = mkdtempSync(join(tmpdir(), 'leak-scan-unreadable-'))
    const locked = join(tree, 'locked.md')

    try {
      writeUnder(tree, 'open.md')
      writeUnder(tree, 'locked.md')
      chmodSync(locked, 0o000)
      // A superuser reads through a mode of nothing, which would leave the rest proving nothing.
      expect(() => readFileSync(locked)).toThrow()

      const scan = scanOf(tree)
      const run = check('private-information', relative(root, tree))

      expect(scan.files).toEqual(['open.md'])
      expect(scan.read).toBe(1)
      expect(scan.unreadable).toEqual(['locked.md'])
      expect(run.status).toBe(1)
      expect(run.output).toContain('1 file(s) it could not read')
      expect(run.output).toContain('could not read locked.md')
    } finally {
      chmodSync(locked, 0o600)
      rmSync(tree, { recursive: true, force: true })
    }
  })

  it('reads no checkout of its own that sits inside the tree, and would read it otherwise', () => {
    // Outside the repository: a directory parked in this tree is read by whatever else
    // enumerates that directory, and dist/ is enumerated by the packaging test.
    const held = mkdtempSync(join(tmpdir(), 'leak-scan-'))
    const inside = join(held, 'somebody-elses-tree')

    try {
      mkdirSync(inside)
      // Assembled rather than written out, for the same reason the synthetic key is: a line
      // that reads as a disclosure is one wherever it sits, including here.
      const elsewhere = ['', 'Users', 'somebody', 'a-tree-of-their-own'].join('/')
      writeFileSync(join(inside, 'notes.md'), `checked out under ${elsewhere}\n`)
      const asAnyDirectory = check('private-information', relative(root, held))

      writeFileSync(join(inside, '.git'), 'gitdir: somewhere else\n')
      const asACheckout = check('private-information', relative(root, held))

      expect(disclosureIdsIn(asAnyDirectory.output)).toEqual(['developer-path'])
      expect(disclosureIdsIn(asACheckout.output)).toEqual([])
      expect(asACheckout.status).toBe(0)
    } finally {
      rmSync(held, { recursive: true, force: true })
    }
  })
})

// Every shape the published allow-list admits, so a scan rule that grows over one of them
// shows up here before a release carries it unread.
const PUBLISHED_SHAPES = [
  'package/CHANGELOG.md',
  'package/LICENSE',
  'package/README.md',
  'package/api/package.json',
  'package/dist/index.cjs',
  'package/dist/index.d.cts',
  'package/dist/index.d.mts',
  'package/dist/index.mjs',
  'package/package.json',
]

describe('the tarball read guard', () => {
  it('names each published file the scan did not read', () => {
    const unread = unreadIn(
      ['package/README.md', 'package/dist/index.cjs', 'package/dist/index.mjs'],
      { files: ['package/dist/index.mjs'] },
    )

    expect(unread).toEqual(['package/README.md', 'package/dist/index.cjs'])
  })

  it('owes a published file a reading whatever the scan\'s own rules say about it', () => {
    const unread = unreadIn(['package/dist/index.wasm', 'package/coverage/index.mjs'], {
      files: [],
    })

    expect(unread).toEqual(['package/dist/index.wasm', 'package/coverage/index.mjs'])
  })

  it('owes nothing for a packed tarball carrying every published shape', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'tarball-guard-'))

    try {
      for (const path of PUBLISHED_SHAPES) {
        writeUnder(workspace, path)
      }

      const tarball = join(workspace, 'package.tgz')
      expect(spawnSync('tar', ['-czf', tarball, '-C', workspace, 'package']).status).toBe(0)
      rmSync(join(workspace, 'package'), { recursive: true, force: true })

      const scan = scanPacked(tarball, workspace)

      expect([...scan.files].sort()).toEqual(PUBLISHED_SHAPES)
      expect(unreadIn(PUBLISHED_SHAPES, scan)).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('a release says the same thing about itself everywhere', () => {
  it('passes a tree whose changelog, contract and manifest agree', () => {
    const run = check('release-metadata', 'test/fixtures/release-metadata/ready')

    expect(problemsIn(run.output)).toEqual([])
    expect(run.status).toBe(0)
  })

  it('catches an unconsumed changeset, a changelog behind the manifest, a stale contract quote and a manifest a registry page would render badly', () => {
    const run = check('release-metadata', 'test/fixtures/release-metadata/unready')
    const problems = problemsIn(run.output).join('\n')

    expect(run.status).toBe(1)
    expect(problems).toContain('a-change-nobody-folded-in.md — is unconsumed (minor)')
    expect(problems).toContain('its newest entry is 1.3.0 and the manifest publishes 1.4.0')
    expect(problems).toContain('quotes contract 3.0.0 and the contract declares 3.1.0')
    expect(problems).toContain('fewer than five keywords')
    expect(problems).toContain('description is too short')
    expect(problems).toContain('does not carry the copyright of Somebody Else')
    expect(problems).toContain('bugs.url is not an https address')
    expect(problems).toContain('bugs.url does not point into an-owner/a-package')
  })

  // A branch is supposed to carry an unconsumed changeset and a release none, so holding the
  // tree to zero problems here would leave no branch on which a changeset could be written.
  it('holds this release to the same reading, bar the changeset a branch carries', () => {
    const run = check('release-metadata')
    const problems = problemsIn(run.output).filter((problem) => !UNCONSUMED.test(problem))

    expect(run.output).toContain('pending changeset(s)')
    expect(problems).toEqual([])
  })
})
