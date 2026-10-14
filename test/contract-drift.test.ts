import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { ROWS, SPLIT, TAG_FALLBACKS, classify, disagreements } from '../contract/classify.mjs'
// @ts-expect-error — a plain script, deliberately not part of the typed source tree
import { COMPARED_POINTERS, tagsFor } from '../contract/drift.mjs'

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
    expect(disagreements(RULE_TABLE, COMPARED_POINTERS)).toEqual([])
  })

  it('mutates every row it holds, and states a condition on the member rows', () => {
    expect([...new Set(MUTATIONS.map(([row]) => row))].sort()).toEqual([...MUTATED_ROWS].sort())
    expect(
      [...new Set(MUTATIONS.filter(([, what]) => what.startsWith('flips')).map(([row]) => row))].sort(),
    ).toEqual(['1', '2a', '2b', '3', '3a', '4'])
  })

  it.each(MUTATIONS)('reports row %s when the table %s', (row, _what, text) => {
    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text, COMPARED_POINTERS)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^rule ${row} — `))]))
  })

  it.each([
    ['stops combining row 2b', 1, (content: string) => content.replace('2b', ''), 'the rule table does not combine row 2b'],
    ['also combines row 7', 1, (content: string) => `${content} and row 7`, 'the rule table combines row 7, which this does not'],
    ['stops taking the union on removed', 2, () => 'intersection', 'on removed the rule table says nothing and this holds union'],
    ['reads a reordering as breaking', 4, () => '`breaking-readers`', 'on reordered the rule table says breaking-readers and this holds additive'],
  ] as const)('reports row 4 when the table %s', (_what, cell, edit, reported) => {
    const text = withCell(RULE_TABLE, SPLIT.row as string, cell, edit)

    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text, COMPARED_POINTERS)).toEqual(expect.arrayContaining([`rule ${SPLIT.row as string} — ${reported}`]))
  })

  it.each((TAG_FALLBACKS as { tag: string }[]).map((entry) => entry.tag))('reports the fallback of %s when the table changes or drops it', (tag) => {
    const row = new RegExp(`^\\| \`${tag}\` \\|.*$`, 'm')

    for (const [text, reported] of [
      [RULE_TABLE.replace(row, `| \`${tag}\` | \`zz\` |`), /^tag fallback — the rule table reads /],
      [RULE_TABLE.replace(row, ''), /^tag fallback — the rule table does not read /],
    ] as const) {
      expect(text).not.toBe(RULE_TABLE)
      expect(disagreements(text, COMPARED_POINTERS)).toEqual(expect.arrayContaining([expect.stringMatching(reported)]))
    }
  })

  it('reports a fallback the table states and this does not hold', () => {
    const text = RULE_TABLE.replace('| `layer` | `server` |', '| `layer` | `server` |\n| `zz_tag` | `on` |')

    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text, COMPARED_POINTERS)).toEqual(
      expect.arrayContaining(['tag fallback — the rule table reads zz_tag as the value on, which this does not']),
    )
  })
})

function lineOf(row: string): string {
  const line = RULE_TABLE.split('\n').find((candidate) => new RegExp(`^\\|\\s*${row}\\s*\\|`).test(candidate))

  if (line === undefined) {
    throw new Error(`the rule table has no row ${row}`)
  }

  return line
}

function withLine(text: string, before: string, line: string): string {
  if (!text.includes(`${before}\n`)) {
    throw new Error(`the rule table has no line ${before}`)
  }

  return text.replace(`${before}\n`, `${before}\n${line}\n`)
}

const ROW_8 = lineOf('8')

const ROW_7 = lineOf('7')

const ROW_49 = lineOf('49')

const ROW_15 = lineOf('15')

const EDITORIAL_LAST = RULE_TABLE.split('\n').find((line) => line.startsWith('| `/title`')) ?? ''

const DOCUMENTED_ONLY = (pattern: string) => `| 52 | \`${pattern}\` | \`additive\` | \`breaking-readers\` | \`breaking-readers\` | \`additive\` |`

describe('the rule table states each row once, in a shape this reads', () => {
  it.each([
    ['a second row 8 before the real one', withLine(RULE_TABLE, ROW_7, ROW_8.replace('`additive`', '`breaking-both`')), /^rule 8 — the rule table documents it more than once$/],
    ['a second row 8 after the real one', withLine(RULE_TABLE, ROW_8, ROW_8.replace('`additive`', '`breaking-both`')), /^rule 8 — the rule table documents it more than once$/],
    ['a second row 8 with a sixth cell', withLine(RULE_TABLE, ROW_7, `${ROW_8} \`additive\` |`), /^rule 8 — the rule table documents it more than once$/],
    ['a row 8 with a sixth cell', withLine(RULE_TABLE, ROW_7, `${ROW_8} \`additive\` |`), /^rule 8 — the rule table states a row this cannot read as five cells$/],
    ['a row numbered 08', withLine(RULE_TABLE, ROW_7, ROW_8.replace('| 8 |', '| 08 |')), /^rule 08 — the rule table numbers a row in a shape this does not read: /],
    ['a row numbered 8c', withLine(RULE_TABLE, ROW_7, ROW_8.replace('| 8 |', '| 8c |')), /^rule 8c — the rule table numbers a row in a shape this does not read: /],
    ['a pipe-led row with no closing pipe', withLine(RULE_TABLE, ROW_49, ROW_49.replace('| 49 |', '| 52 |').replace(/\|\s*$/, '')), /^rule 52 — the rule table states a row this cannot read as five cells$/],
    ['a pipe-led row with four cells', withLine(RULE_TABLE, ROW_49, '| 52 | `/zz/*` | `additive` | — | — |'), /^rule 52 — the rule table states a row this cannot read as five cells$/],
    ['a row of its own on a pointer the drift watch compares and row 15 classifies', withLine(RULE_TABLE, ROW_49, DOCUMENTED_ONLY('/api/read_shapes/*/keys')), /^rule 52 — .*\/api\/read_shapes\/monitor\/keys.*rule 15/],
    ['a row of its own under a wider pattern over a pointer row 8 classifies', withLine(RULE_TABLE, ROW_49, DOCUMENTED_ONLY('/api/constraints/**')), /^rule 52 — .*\/api\/constraints\/monitor\.name\/max_length.*rule 8/],
    ['a row of its own with no pointer and nothing to inherit', withLine(RULE_TABLE, ROW_49, '| 52 | every bound | `additive` | — | — | — |'), /^rule 52 — the rule table states no pointer for it/],
    ['a renamed heading', RULE_TABLE.replace('## Rule table\n', '## Rules\n'), /^rule table — the document has no "## Rule table" heading/],
    ['a malformed row after the editorial heading', withLine(RULE_TABLE, EDITORIAL_LAST, '| 52 | `/zz/*` | `additive` |'), /^rule 52 — the rule table states a row this cannot read as five cells$/],
    ['a duplicate row after the editorial heading', withLine(RULE_TABLE, EDITORIAL_LAST, ROW_8), /^rule 8 — the rule table documents it more than once$/],
    ['a row without its leading pipe', withLine(RULE_TABLE, ROW_49, ROW_49.replace(/^\| 49 /, '52 ')), /^rule table — a line of the section holds a pipe and does not open with one: "52 \|/],
    ['an HTML comment', withLine(RULE_TABLE, ROW_49, `<!--\n${ROW_49.replace('| 49 |', '| 52 |')}\n-->`), /^rule table — line \d+ opens an HTML comment/],
    ['a pipe escaped inside a verdict cell, read as content of that cell', RULE_TABLE.replace(ROW_15, ROW_15.replace('| `additive` |', '| `additive` \\| `breaking-both` |')), /^rule 15 — on added the rule table states more than one verdict, or a condition$/],
    ['a row whose number is bold', withLine(RULE_TABLE, ROW_49, ROW_49.replace('| 49 |', '| **52** |')), /^rule table — a line of the section this cannot read: "\| \*\*52\*\*/],
    ['a row whose number is quoted as code', withLine(RULE_TABLE, ROW_49, ROW_49.replace('| 49 |', '| `52` |')), /^rule table — a line of the section this cannot read: /],
    ['a row whose number is written in fullwidth digits', withLine(RULE_TABLE, ROW_49, ROW_49.replace('| 49 |', '| \uFF15\uFF12 |')), /^rule table — a line of the section this cannot read: /],
    ['a row whose number follows a zero-width space', withLine(RULE_TABLE, ROW_49, ROW_49.replace('| 49 |', '| \u200B52 |')), /^rule table — a line of the section this cannot read: /],
    ['a second rule table heading', `${RULE_TABLE}\n## Rule table\n`, /^rule table — the document has more than one "## Rule table" heading$/],
    ['a fenced block inside the section', withLine(RULE_TABLE, ROW_49, '```\n| 52 | `/zz/*` | `additive` | — | — | — |\n```'), /^rule table — line \d+ opens a fenced block inside the section$/],
  ])('reports %s', (_what, text, reported) => {
    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text, COMPARED_POINTERS)).toEqual(expect.arrayContaining([expect.stringMatching(reported)]))
  })

  it.each([
    ['a row of its own on a pointer nothing compares', withLine(RULE_TABLE, ROW_49, DOCUMENTED_ONLY('/zz/disjoint/*'))],
    ['a row of its own on a compared pointer no classifier row holds', withLine(RULE_TABLE, ROW_49, DOCUMENTED_ONLY('/api/signup/user_code_pattern'))],
    ['a row of its own that inherits the pointer of the row before it', withLine(RULE_TABLE, ROW_49, '| 52 | the same — lowered | — | — | `breaking-writers` | — |')],
    ['a row numbered 8 outside the rule table section', withLine(RULE_TABLE, '| Verdict | Meaning |', '| 8 | x |')],
    ['a fenced copy of the heading before the real one', RULE_TABLE.replace('## Rule table\n', '```\n## Rule table\n| 8 | x |\n```\n\n## Rule table\n')],
  ])('stays silent on %s', (_what, text) => {
    expect(text).not.toBe(RULE_TABLE)
    expect(disagreements(text, COMPARED_POINTERS)).toEqual([])
  })

  it('finds the heading past a commented-out copy of it, and reports only the comment', () => {
    const text = RULE_TABLE.replace('## Rule table\n', '<!--\n## Rule table\n| 8 | x |\n-->\n\n## Rule table\n')

    expect(disagreements(text, COMPARED_POINTERS)).toEqual([expect.stringMatching(/^rule table — line \d+ opens an HTML comment/)])
  })

  it('reads the pointers the drift watch compares, not a list of its own', () => {
    expect([...COMPARED_POINTERS].sort()).toEqual(Object.keys(shipped().facts).sort())
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

  it('reads a destination limit a kind states for itself, in both directions', () => {
    const pointer = '/api/constraints/channel.webhook_url/max_length_by_kind/slack'
    const lowered = drift(['--snapshot', mutated((facts) => { facts[pointer] = 100 })])
    const raised = drift(['--snapshot', mutated((facts) => { facts[pointer] = 300 })])

    expect(shipped().facts[pointer]).toBe(255)
    expect(lowered.output).toContain('breaking-writers')
    expect(lowered.status).toBe(1)
    expect(raised.output).toContain('additive')
    expect(raised.status).toBe(0)
  })

  it('states a webhook destination limit for every kind that needs one, and none for another', () => {
    const kinds = Object.keys(shipped().facts)
      .filter((pointer) => pointer.startsWith('/api/constraints/channel.webhook_url/max_length_by_kind/'))
      .map((pointer) => pointer.split('/').at(-1))
      .sort()
    const needing = (JSON.parse(readFileSync(CONTRACT, 'utf8')) as {
      api: { constraints: Record<string, { required_for_kinds: string[] }> }
    }).api.constraints['channel.webhook_url']?.required_for_kinds

    expect(kinds).toEqual([...(needing ?? [])].sort())
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
