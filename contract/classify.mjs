// The verdicts and the pointer classes below are transcribed from CLASSIFICATION.md, row for
// row, and a test reads that file and fails on any cell the two disagree about. Restating the
// table here rather than parsing the prose keeps the rules readable; the test is what keeps
// the two from becoming separate opinions about what breaking means.

const RANK = { editorial: 0, additive: 1, 'breaking-readers': 2, 'breaking-writers': 2, 'breaking-both': 3, undecidable: 4 }

const VOCABULARY_MEMBERS = '/vocabularies/*/members'

const READ_ROWS = [
  { row: '1', when: (tags) => tags.openness === 'open', cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '2a', when: (tags) => tags.openness === 'closed' && tags.layer !== 'client-convention', cells: { added: 'breaking-readers', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '2b', when: (tags) => tags.openness === 'closed' && tags.layer === 'client-convention', cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
]

const WRITE_ROW = { row: '3', cells: { added: 'additive', removed: 'breaking-writers', changed: 'breaking-writers', reordered: 'additive' } }

// Rows the drift watch can reach. A pointer no row below matches is undecidable, which is the
// safe default: an unplaced difference fails rather than passing quietly.
export const ROWS = [
  ...READ_ROWS.map((entry) => ({ ...entry, patterns: [VOCABULARY_MEMBERS], side: 'read' })),
  { ...WRITE_ROW, patterns: [VOCABULARY_MEMBERS], side: 'write' },
  { row: '7', patterns: ['/api/constraints/schedule.simple/allowlist'], cells: { added: 'additive', removed: 'breaking-writers', changed: 'breaking-writers', reordered: 'additive' } },
  { row: '8', patterns: ['/api/constraints/*/max*', '/**/max_value', '/**/cap_bytes'], bound: 'raised', cells: { changed: 'additive' } },
  { row: '9', patterns: ['/api/constraints/*/max*', '/**/max_value', '/**/cap_bytes'], bound: 'lowered', cells: { changed: 'breaking-writers' } },
  { row: '10', patterns: ['/api/constraints/*/min*'], bound: 'lowered', cells: { changed: 'additive' } },
  { row: '11', patterns: ['/api/constraints/*/min*'], bound: 'raised', cells: { changed: 'breaking-writers' } },
  { row: '13', patterns: ['/api/constraints/*/required_for_kinds', '/api/constraints/*/not_blank', '/api/constraints/*/required'], cells: { added: 'breaking-writers', removed: 'additive', changed: 'breaking-writers', reordered: 'additive' } },
  { row: '14', patterns: ['/api/constraints/*/default'], cells: { changed: 'breaking-both' } },
  { row: '15', patterns: ['/api/read_shapes/*/keys'], cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '16', patterns: ['/api/read_shapes/*/nullable'], cells: { added: 'breaking-readers', removed: 'additive', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '17', patterns: ['/api/read_shapes/*/absent_by_design'], cells: { added: 'breaking-readers', removed: 'additive', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '18', patterns: ['/api/pagination/shapes/*/response_keys'], cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '19', patterns: ['/api/pagination/shapes/*/request_params'], cells: { added: 'additive', removed: 'breaking-writers', changed: 'breaking-writers', reordered: 'additive' } },
  { row: '20', patterns: ['/api/pagination/shapes/*/termination', '/api/pagination/limit_clamp/**', '/api/pagination/offset_clamp/**'], cells: { changed: 'breaking-both' } },
  { row: '25', patterns: ['/api/identifiers/*/read_type'], cells: { changed: 'breaking-readers' } },
  { row: '26', patterns: ['/api/identifiers/*/write_type'], bound: 'widened', cells: { changed: 'additive' } },
  { row: '27', patterns: ['/api/identifiers/*/write_type'], bound: 'narrowed', cells: { changed: 'breaking-writers' } },
]

function segmentsMatch(pattern, segment) {
  return pattern === '*' || pattern === segment || (pattern.endsWith('*') && segment.startsWith(pattern.slice(0, -1)))
}

export function matches(pattern, pointer) {
  const wanted = pattern.split('/').slice(1)
  const actual = pointer.split('/').slice(1)

  if (!wanted.includes('**')) {
    return wanted.length === actual.length && wanted.every((part, index) => segmentsMatch(part, actual[index]))
  }

  const before = wanted.slice(0, wanted.indexOf('**'))
  const after = wanted.slice(wanted.indexOf('**') + 1)

  return (
    actual.length >= before.length + after.length &&
    before.every((part, index) => segmentsMatch(part, actual[index])) &&
    after.every((part, index) => segmentsMatch(part, actual[actual.length - after.length + index]))
  )
}

function boundOf(before, after) {
  if (typeof before === 'number' && typeof after === 'number') {
    return after > before ? 'raised' : 'lowered'
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    return before.every((member) => after.includes(member)) ? 'widened' : 'narrowed'
  }

  return undefined
}

// The union of rows 1/2a/2b and row 3, which is what row 4 says a read+write vocabulary takes.
export function union(verdicts) {
  if (verdicts.length === 0) {
    return 'undecidable'
  }

  const distinct = [...new Set(verdicts)]

  if (distinct.includes('undecidable')) {
    return 'undecidable'
  }

  if (distinct.includes('breaking-readers') && distinct.includes('breaking-writers')) {
    return 'breaking-both'
  }

  return distinct.reduce((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst))
}

function rowsFor(difference, tags) {
  const applicable = ROWS.filter((row) => row.patterns.some((pattern) => matches(pattern, difference.pointer)))
  const bound = boundOf(difference.before, difference.after)

  return applicable.filter((row) => {
    if (row.bound !== undefined && row.bound !== bound) {
      return false
    }

    if (row.side === 'read' && !String(tags.direction ?? '').includes('read')) {
      return false
    }

    if (row.side === 'write' && !String(tags.direction ?? '').includes('write')) {
      return false
    }

    return row.when === undefined || row.when(tags)
  })
}

// A difference is (pointer, direction, before, after); tags are the enclosing object's
// openness / direction / layer, which rows 1 through 4 read and every other row ignores.
export function classify(difference, tags = {}) {
  const rows = rowsFor(difference, tags)

  if (rows.length === 0) {
    return { verdict: 'undecidable', rows: [] }
  }

  const verdicts = rows.map((row) => row.cells[difference.direction] ?? 'undecidable')

  return { verdict: union(verdicts), rows: rows.map((row) => row.row) }
}

const VERDICTS = new Set(['additive', 'breaking-readers', 'breaking-writers', 'breaking-both', 'undecidable', 'editorial'])

const DIRECTIONS = ['added', 'removed', 'changed', 'reordered']

const RULE_ROW = /^\|\s*(\d+[ab]?)\s*\|(.+)\|\s*$/

function quoted(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((held) => held[1])
}

function verdictIn(cell) {
  return quoted(cell).find((held) => VERDICTS.has(held))
}

export function parseRuleTable(markdown) {
  const rows = new Map()
  let previous

  for (const line of markdown.split('\n')) {
    const matched = RULE_ROW.exec(line)
    const cells = matched === null ? [] : matched[2].split('|').map((cell) => cell.trim())

    if (matched === null || cells.length !== 5) {
      continue
    }

    const stated = quoted(cells[0]).filter((held) => held.startsWith('/'))
    const patterns = stated.length > 0 ? stated : (previous?.patterns ?? [])

    previous = { patterns, cells: Object.fromEntries(DIRECTIONS.map((direction, index) => [direction, verdictIn(cells[index + 1])])) }
    rows.set(matched[1], previous)
  }

  return rows
}

// The rows above are a transcription, and a transcription is only worth what checking it
// costs. Anything the job classifies is classified by a row this reports agreement on.
export function disagreements(markdown) {
  const documented = parseRuleTable(markdown)

  return ROWS.flatMap((row) => {
    const stated = documented.get(row.row)

    if (stated === undefined) {
      return [`rule ${row.row} — the rule table documents no row by that number`]
    }

    return [
      ...row.patterns
        .filter((pattern) => !stated.patterns.includes(pattern))
        .map((pattern) => `rule ${row.row} — the rule table does not name ${pattern}`),
      ...DIRECTIONS.filter((direction) => (row.cells[direction] ?? undefined) !== stated.cells[direction]).map(
        (direction) =>
          `rule ${row.row} — on ${direction} the rule table says ${stated.cells[direction] ?? 'nothing'} and this holds ${row.cells[direction] ?? 'nothing'}`,
      ),
    ]
  })
}
