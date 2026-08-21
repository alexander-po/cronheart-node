import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
    'catches a sample that no longer compiles, a flag no command takes, a command that is gone, a variable nothing reads and a recipe that does not exist',
    () => {
      const run = check('doc-claims', 'test/fixtures/doc-claims/dirty')
      const problems = problemsIn(run.output).join('\n')

      expect(run.status).toBe(1)
      expect(problems).toContain("'actoin' does not exist")
      expect(problems).toContain('--quietly is documented and no cronheart command takes it')
      expect(problems).toContain('cronheart has no reconcile command')
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
  })

  it('holds the repository itself to the same reading, over a tree it is shown to have read', () => {
    const run = check('private-information', '.')

    expect(disclosureIdsIn(run.output)).toEqual([])
    expect(run.status).toBe(0)
    // A floor, not a total: what it guards is a skip quietly swallowing the tree, and the
    // one measured way that happens — a stray checkout over a source directory — lands here.
    expect(filesReadIn(run.output)).toBeGreaterThan(200)
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
