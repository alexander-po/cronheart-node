import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)

const NO_NETWORK = './test/fixtures/drift/no-network.mjs'

const SNAPSHOT = new URL('contract/server-snapshot.json', root)

const CONTRACT = new URL('contract/cronheart-contract.json', root)

interface Run {
  readonly status: number | null
  readonly output: string
}

function drift(args: readonly string[], preload?: string): Run {
  const run = spawnSync(
    process.execPath,
    [...(preload === undefined ? [] : ['--import', preload]), 'contract/drift.mjs', ...args],
    { cwd: fileURLToPath(root), encoding: 'utf8' },
  )

  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

interface Snapshot {
  facts: Record<string, unknown>
  [key: string]: unknown
}

function shipped(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Snapshot
}

// A snapshot the server might have published, written where the job can be pointed at it.
function mutated(change: (facts: Record<string, unknown>) => void): string {
  const snapshot = shipped()
  change(snapshot.facts)
  const path = join(mkdtempSync(join(tmpdir(), 'cronheart-drift-')), 'server-snapshot.json')
  writeFileSync(path, JSON.stringify(snapshot, null, 2))

  return path
}

function members(facts: Record<string, unknown>, pointer: string): string[] {
  const held = facts[pointer]

  if (!Array.isArray(held)) {
    throw new Error(`the shipped snapshot states no members at ${pointer}`)
  }

  return held as string[]
}

describe('the drift watch compares the contract against what the server publishes', () => {
  it('reads the shipped snapshot as agreeing with the contract', () => {
    const run = drift([])

    expect(run.output).toContain('no difference')
    expect(run.status).toBe(0)
  })

  it('reaches every fact the snapshot states, so a pointer cannot go uncompared', () => {
    const run = drift([])
    const compared = /(\d+) fact\(s\) compared/.exec(run.output)

    expect(compared).not.toBeNull()
    expect(Number(compared?.[1])).toBe(Object.keys(shipped().facts).length)
    expect(Number(compared?.[1])).toBeGreaterThan(20)
  })

  it('fails on a vocabulary member the server stopped offering', () => {
    const path = mutated((facts) => {
      facts['/vocabularies/schedule.kind/members'] = members(
        facts,
        '/vocabularies/schedule.kind/members',
      ).filter((member) => member !== 'simple')
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('/vocabularies/schedule.kind/members')
    expect(run.output).toContain('removed "simple"')
    expect(run.output).toMatch(/breaking-(readers|writers|both)/)
    expect(run.status).toBe(1)
  })

  it('passes a member an open read vocabulary gained, which is the whole point of the tags', () => {
    const path = mutated((facts) => {
      facts['/vocabularies/monitor.status/members'] = [
        ...members(facts, '/vocabularies/monitor.status/members'),
        'degraded',
      ]
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('added "degraded"')
    expect(run.output).toContain('additive')
    expect(run.output).not.toMatch(/breaking-/)
    expect(run.status).toBe(0)
  })

  // The same edit in the two directions, because a job that failed on every difference would
  // pass the removal case above while being useless.
  it('fails on a bound the server lowered and passes the same bound raised', () => {
    const lowered = drift([
      '--snapshot',
      mutated((facts) => {
        facts['/api/constraints/monitor.name/max_length'] = 80
      }),
    ])
    const raised = drift([
      '--snapshot',
      mutated((facts) => {
        facts['/api/constraints/monitor.name/max_length'] = 200
      }),
    ])

    expect(lowered.output).toContain('breaking-writers')
    expect(lowered.status).toBe(1)
    expect(raised.output).toContain('additive')
    expect(raised.status).toBe(0)
  })

  it('fails on a difference the rules cannot place rather than passing it quietly', () => {
    const path = mutated((facts) => {
      facts['/api/identifiers/monitor/format'] = 'ulid'
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('/api/identifiers/monitor/format')
    expect(run.output).toContain('undecidable')
    expect(run.status).toBe(1)
  })

  it('fails when the published document stopped carrying a fact the job was reading', () => {
    const path = mutated((facts) => {
      delete facts['/api/pagination/limit_clamp/max']
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('/api/pagination/limit_clamp/max')
    expect(run.output).toContain('states nothing')
    expect(run.status).toBe(1)
  })

  // Read from the contract rather than written into the job: the second run points at a
  // contract whose list says something else, and the output has to follow it.
  it('says what the published document cannot see, in the contract’s own words', () => {
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      api: { openapi_document: { does_not_cover: string[] } }
    }
    const stated = contract.api.openapi_document.does_not_cover
    const run = drift([])

    expect(stated.length).toBeGreaterThan(0)

    for (const gap of stated) {
      expect(run.output).toContain(gap)
    }

    contract.api.openapi_document.does_not_cover = ['a gap no shipped contract states']
    const path = join(mkdtempSync(join(tmpdir(), 'cronheart-drift-')), 'contract.json')
    writeFileSync(path, JSON.stringify(contract, null, 2))
    const other = drift(['--contract', path])

    expect(other.output).toContain('a gap no shipped contract states')
    expect(other.output).not.toContain(stated[0] as string)
  })

  // The classifier is a transcription of the rule table this repository documents, so the job
  // reads that table on every run and refuses to classify anything on rules that have parted
  // from it. Flipping one documented cell is what proves the reading is not decorative.
  it('refuses to run when the classifier and the documented rule table disagree', () => {
    const rules = readFileSync(new URL('contract/CLASSIFICATION.md', root), 'utf8')
    const flipped = rules.replace(
      '| 15 | `/api/read_shapes/*/keys` | `additive` |',
      '| 15 | `/api/read_shapes/*/keys` | `breaking-readers` |',
    )
    const path = join(mkdtempSync(join(tmpdir(), 'cronheart-drift-')), 'CLASSIFICATION.md')
    writeFileSync(path, flipped)

    expect(flipped).not.toBe(rules)

    const run = drift(['--rules', path])

    expect(run.output).toContain('disagree')
    expect(run.output).toContain('rule 15 — on added')
    expect(run.status).toBe(1)
  })

  // The offline run is the one a pull request waits on, so an unreachable service must not be
  // able to turn it red. The live run under the same block is the positive control: without
  // it, a preload that never took effect would read exactly like a job that never fetches.
  it('makes no request offline, and does make one live', () => {
    const offline = drift([], NO_NETWORK)
    const live = drift(['--live'], NO_NETWORK)

    expect(offline.output).not.toContain('reached the network')
    expect(offline.status).toBe(0)
    expect(live.output).toContain('reached the network')
    expect(live.status).toBe(1)
  })

  it('rewrites the snapshot and asks for a pull request when the live document has moved', () => {
    const snapshot = mutated(() => {})
    const run = drift(
      ['--live', '--snapshot', snapshot],
      './test/fixtures/drift/serve-a-widened-document.mjs',
    )
    const written = JSON.parse(readFileSync(snapshot, 'utf8')) as Snapshot

    expect(run.output).toContain('open a pull request')
    expect(run.status).toBe(3)
    expect(written.facts['/api/constraints/monitor.name/max_length']).toBe(200)
  })

  // An empty snapshot rather than the shipped one: pointed at a snapshot that already holds
  // the answer, a projection reaching none of the document would be indistinguishable from
  // one reaching all of it.
  it('projects every fact the shipped snapshot states out of a served document', () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'cronheart-drift-')), 'server-snapshot.json')
    writeFileSync(empty, JSON.stringify({ source: shipped().source, facts: {} }, null, 2))

    const run = drift(['--live', '--snapshot', empty], './test/fixtures/drift/serve-the-document.mjs')
    const written = JSON.parse(readFileSync(empty, 'utf8')) as Snapshot

    expect(run.status).toBe(3)
    expect(Object.keys(written.facts).sort()).toEqual(Object.keys(shipped().facts).sort())
  })
})
