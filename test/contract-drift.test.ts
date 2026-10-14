import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { ROWS, SPLIT, TAG_FALLBACKS, classify, disagreements } from '../contract/classify.mjs'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { tagsFor } from '../contract/drift.mjs'

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

describe('the classifier reads the write half of a vocabulary on its own', () => {
  const added = { pointer: '/vocabularies/any.kind/members', direction: 'added', before: ['a'], after: ['a', 'b'] }

  it.each([
    ['stated open', { direction: 'write', openness: 'closed', write_openness: 'open' }, 'additive', ['3']],
    ['stated closed', { direction: 'write', openness: 'open', write_openness: 'closed' }, 'writers-behind', ['3a']],
    ['not stated, under a closed vocabulary', { direction: 'write', openness: 'closed' }, 'writers-behind', ['3a']],
    ['not stated, under an open vocabulary', { direction: 'write', openness: 'open' }, 'additive', ['3']],
  ])('classifies a member added to a write half %s', (_id, tags, verdict, rows) => {
    expect(classify(added, tags)).toEqual({ verdict, rows })
  })

  it('reads a closed read vocabulary that states no layer as the service’s', () => {
    expect(classify(added, { direction: 'read', openness: 'closed' })).toEqual({ verdict: 'breaking-readers', rows: ['2a'] })
  })

  it('leaves a read and write vocabulary undecided when one half matches no row', () => {
    expect(classify(added, { direction: 'read+write', openness: 'closed', write_openness: 'open', layer: 'edge' })).toEqual({
      verdict: 'undecidable',
      rows: [],
    })
  })
})

interface Vocabulary {
  readonly openness?: string
  readonly write_openness?: string
  readonly direction?: string
  readonly layer?: string
}

const VERDICTS_BY_DIRECTION: Readonly<Record<string, readonly string[]>> = {
  'alert.kind': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'channel.kind': ['writers-behind', 'breaking-both', 'breaking-both', 'additive'],
  'incident.kind': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'monitor.status': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'ping.action': ['writers-behind', 'breaking-writers', 'breaking-writers', 'additive'],
  'ping.kind': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'ping.outcome': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'plan.key': ['additive', 'breaking-readers', 'breaking-readers', 'additive'],
  'schedule.kind': ['breaking-readers', 'breaking-both', 'breaking-both', 'additive'],
  'snooze.duration': ['writers-behind', 'breaking-writers', 'breaking-writers', 'additive'],
}

describe('every vocabulary the contract states keeps the verdicts its tags select', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as { vocabularies: Record<string, unknown> }
  const vocabularies = Object.entries(contract.vocabularies).filter(
    (entry): entry is [string, Vocabulary] => typeof entry[1] === 'object' && entry[1] !== null,
  )

  it('names each one', () => {
    expect(vocabularies.map(([name]) => name).sort()).toEqual(Object.keys(VERDICTS_BY_DIRECTION).sort())
  })

  it.each(vocabularies)('classifies %s by the tags the drift watch reads for it', (name) => {
    const pointer = `/vocabularies/${name}/members`
    const verdicts = ['added', 'removed', 'changed', 'reordered'].map(
      (change) =>
        (classify({ pointer, direction: change, before: ['a'], after: ['a', 'b'] }, tagsFor(contract, pointer)) as {
          verdict: string
        }).verdict,
    )

    expect(verdicts).toEqual(VERDICTS_BY_DIRECTION[name])
  })
})

const RULE_TABLE = readFileSync(new URL('contract/CLASSIFICATION.md', root), 'utf8')

const OPPOSITE_BOUND: Readonly<Record<string, string>> = {
  raised: 'lowered',
  lowered: 'raised',
  widened: 'narrowed',
  narrowed: 'widened',
}

function withCell(text: string, row: string, cell: number, edit: (content: string) => string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => new RegExp(`^\\|\\s*${row}\\s*\\|`).test(line))

  if (at === -1) {
    throw new Error(`the rule table has no row ${row}`)
  }

  const parts = (lines[at] as string).split('|')
  parts[cell + 2] = ` ${edit((parts[cell + 2] ?? '').trim())} `
  lines[at] = parts.join('|')

  return lines.join('\n')
}

function pointerCellOf(row: string): string {
  let content = ''
  withCell(RULE_TABLE, row, 0, (cell) => (content = cell))

  return content
}

const QUALIFIERS = ['or', 'unless', 'except', 'not', 'when the vocabulary is deprecated']

function firstVerdictCellOf(row: string): number {
  let found = -1

  for (const index of [1, 2, 3, 4]) {
    withCell(RULE_TABLE, row, index, (content) => {
      if (found === -1 && /`(additive|writers-behind|breaking-[a-z]+|undecidable)`/.test(content)) {
        found = index
      }

      return content
    })
  }

  return found
}

function mutationsOf(row: string): (readonly [string, string])[] {
  const cell = pointerCellOf(row)
  const bound = /\b(raised|lowered|widened|narrowed)\b/.exec(cell)?.[1]
  const pairs = [...cell.matchAll(/`([a-z_]+): (\S+)`/g)]
  const patterns = [...cell.matchAll(/`(\/[^`]+)`/g)].map(([held]) => held)
  const verdictCell = firstVerdictCellOf(row)

  return [
    ['adds a tag pair', withCell(RULE_TABLE, row, 0, (content) => `${content} **and** \`zz_tag: on\``)],
    ['adds a quoted qualifier', withCell(RULE_TABLE, row, 0, (content) => `${content} **and** \`not deprecated\``)],
    ['adds a pattern', withCell(RULE_TABLE, row, 0, (content) => `${content} and \`/zz/*\``)],
    ...QUALIFIERS.map(
      (words) => [`qualifies it with "${words}"`, withCell(RULE_TABLE, row, 0, (content) => `${content} ${words}`)] as const,
    ),
    ...patterns.map(
      (held) => [`drops ${held}`, withCell(RULE_TABLE, row, 0, (content) => content.replace(held, '').replace(/(,|and)\s*$/, ''))] as const,
    ),
    ...(verdictCell === -1
      ? []
      : ([
          ['adds a second verdict', withCell(RULE_TABLE, row, verdictCell, (content) => `${content} or \`breaking-both\``)],
          ['adds a condition to a verdict', withCell(RULE_TABLE, row, verdictCell, (content) => `${content} where \`layer: server\``)],
          ['qualifies a verdict in words', withCell(RULE_TABLE, row, verdictCell, (content) => `${content.split(' — ')[0] ?? content} unless deprecated`)],
        ] as const)),
    bound === undefined
      ? ['adds a bound', withCell(RULE_TABLE, row, 0, (content) => `${content} — bound **raised**`)]
      : ['swaps its bound', withCell(RULE_TABLE, row, 0, (content) => content.replace(bound, OPPOSITE_BOUND[bound] ?? bound))],
    ...pairs.flatMap(([held, tag, value]) => [
      [`flips ${tag}`, withCell(RULE_TABLE, row, 0, (content) => content.replace(held, `\`${tag}: zz-${value}\``))] as const,
      [`drops ${tag}`, withCell(RULE_TABLE, row, 0, (content) => content.replace(held, ''))] as const,
      [`states ${tag} twice`, withCell(RULE_TABLE, row, 0, (content) => `${content} **and** \`${tag}: ${value}\``)] as const,
    ]),
  ]
}

const MUTATED_ROWS = [...(ROWS as { row: string }[]).map((entry) => entry.row), SPLIT.row as string]

const MUTATIONS = MUTATED_ROWS.flatMap((row) =>
  mutationsOf(row).map(([what, text]) => [row, what, text] as const),
)

describe('the classifier and the documented rule table agree on what each row covers', () => {
  it('agrees on the committed table', () => {
    expect(disagreements(RULE_TABLE)).toEqual([])
  })

  it('mutates every row it holds, and states a condition on the member rows', () => {
    expect([...new Set(MUTATIONS.map(([row]) => row))].sort()).toEqual([...MUTATED_ROWS].sort())
    expect(
      [...new Set(MUTATIONS.filter(([, what]) => what.startsWith('flips')).map(([row]) => row))].sort(),
    ).toEqual(['1', '2a', '2b', '3', '3a', '4'])
  })

  it.each(MUTATIONS)('reports row %s when the table %s', (row, _what, text) => {
    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^rule ${row} — `))]))
  })

  it.each([
    ['stops combining row 2b', 1, (content: string) => content.replace('2b', ''), 'the rule table does not combine row 2b'],
    ['also combines row 7', 1, (content: string) => `${content} and row 7`, 'the rule table combines row 7, which this does not'],
    ['stops taking the union on removed', 2, () => 'intersection', 'on removed the rule table says nothing and this holds union'],
    ['reads a reordering as breaking', 4, () => '`breaking-readers`', 'on reordered the rule table says breaking-readers and this holds additive'],
  ] as const)('reports row 4 when the table %s', (_what, cell, edit, reported) => {
    const text = withCell(RULE_TABLE, SPLIT.row as string, cell, edit)

    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text)).toEqual(expect.arrayContaining([`rule ${SPLIT.row as string} — ${reported}`]))
  })

  it.each((TAG_FALLBACKS as { tag: string }[]).map((entry) => entry.tag))('reports the fallback of %s when the table changes or drops it', (tag) => {
    const row = new RegExp(`^\\| \`${tag}\` \\|.*$`, 'm')

    for (const [text, reported] of [
      [RULE_TABLE.replace(row, `| \`${tag}\` | \`zz\` |`), /^tag fallback — the rule table reads /],
      [RULE_TABLE.replace(row, ''), /^tag fallback — the rule table does not read /],
    ] as const) {
      expect(text).not.toBe(RULE_TABLE)
      expect(disagreements(text)).toEqual(expect.arrayContaining([expect.stringMatching(reported)]))
    }
  })

  it('reports a fallback the table states and this does not hold', () => {
    const text = RULE_TABLE.replace('| `layer` | `server` |', '| `layer` | `server` |\n| `zz_tag` | `on` |')

    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text)).toEqual(
      expect.arrayContaining(['tag fallback — the rule table reads zz_tag as the value on, which this does not']),
    )
  })
})

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

  it('passes a member a read-only open vocabulary gained', () => {
    const path = mutated((facts) => {
      facts['/vocabularies/alert.kind/members'] = [
        ...members(facts, '/vocabularies/alert.kind/members'),
        'escalated',
      ]
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('added "escalated" — additive')
    expect(run.status).toBe(0)
  })

  // The read half of the channel kinds is open and its write half closed, so this is the case
  // that tells a write half read off its own tag from one read off the vocabulary's openness.
  it.each([
    ['/vocabularies/channel.kind/members', 'carrier_pigeon'],
    ['/vocabularies/snooze.duration/members', '1m'],
  ])('fails on a member %s gained, which a writer validating a closed list refuses', (pointer, member) => {
    const path = mutated((facts) => {
      facts[pointer] = [...members(facts, pointer), member]
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain(`${pointer} — added "${member}" — writers-behind (rule `)
    expect(run.output).toMatch(/writers-behind \(rule [0-9a-z, ]*\b3a\)/)
    expect(run.output).not.toMatch(/breaking-/)
    expect(run.status).toBe(1)
  })

  it('reads a member a closed read and write vocabulary gained as breaking its readers, not as writers behind', () => {
    const path = mutated((facts) => {
      facts['/vocabularies/schedule.kind/members'] = [
        ...members(facts, '/vocabularies/schedule.kind/members'),
        'calendar',
      ]
    })
    const run = drift(['--snapshot', path])

    expect(run.output).toContain('added "calendar" — breaking-readers (rule 2a, 3a)')
    expect(run.output).not.toContain('writers-behind')
    expect(run.status).toBe(1)
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
    expect(written.facts).toEqual(shipped().facts)
  })

  // The served document states open_incident as a reference or null and every other nullable
  // monitor field as a type list, so a projection reading only the list loses exactly one key.
  it('reads a field published as a reference or null as nullable', () => {
    const empty = join(mkdtempSync(join(tmpdir(), 'cronheart-drift-')), 'server-snapshot.json')
    writeFileSync(empty, JSON.stringify({ source: shipped().source, facts: {} }, null, 2))

    drift(['--live', '--snapshot', empty], './test/fixtures/drift/serve-the-document.mjs')
    const written = JSON.parse(readFileSync(empty, 'utf8')) as Snapshot
    const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      api: { read_shapes: { monitor: { nullable: string[] } } }
    }

    expect(members(written.facts, '/api/read_shapes/monitor/nullable')).toEqual(
      contract.api.read_shapes.monitor.nullable,
    )
    expect(contract.api.read_shapes.monitor.nullable).toContain('open_incident')
  })
})
