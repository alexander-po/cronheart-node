// The verdicts and the pointer classes below are transcribed from CLASSIFICATION.md, row for
// row, and a test reads that file and fails on any cell the two disagree about. Restating the
// table here rather than parsing the prose keeps the rules readable; the test is what keeps
// the two from becoming separate opinions about what breaking means.

const RANK = { editorial: 0, additive: 1, 'writers-behind': 2, 'breaking-readers': 3, 'breaking-writers': 3, 'breaking-both': 4, undecidable: 5 }

const VOCABULARY_MEMBERS = '/vocabularies/*/members'

export const TAG_FALLBACKS = [
  { tag: 'layer', value: 'server' },
  { tag: 'write_openness', from: 'openness' },
]

const MEMBER_ROWS = [
  { row: '1', condition: { direction: 'read', openness: 'open' }, cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '2a', condition: { direction: 'read', openness: 'closed', layer: 'server' }, cells: { added: 'breaking-readers', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '2b', condition: { direction: 'read', openness: 'closed', layer: 'client-convention' }, cells: { added: 'additive', removed: 'breaking-readers', changed: 'breaking-readers', reordered: 'additive' } },
  { row: '3', condition: { direction: 'write', write_openness: 'open' }, cells: { added: 'additive', removed: 'breaking-writers', changed: 'breaking-writers', reordered: 'additive' } },
  { row: '3a', condition: { direction: 'write', write_openness: 'closed' }, cells: { added: 'writers-behind', removed: 'breaking-writers', changed: 'breaking-writers', reordered: 'additive' } },
]

// Row 4: a vocabulary both read and written takes the member rows of each half, and the union.
export const SPLIT = { row: '4', patterns: [VOCABULARY_MEMBERS], condition: { direction: 'read+write' }, halves: ['read', 'write'], combine: union }

// Rows the drift watch can reach. A pointer no row below matches is undecidable, which is the
// safe default: an unplaced difference fails rather than passing quietly.
export const ROWS = [
  ...MEMBER_ROWS.map((entry) => ({ ...entry, patterns: [VOCABULARY_MEMBERS] })),
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

// The union of rows 1/2a/2b and row 3/3a, which is what row 4 says a read+write vocabulary takes.
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

function withFallbacks(tags) {
  const read = { ...tags }

  for (const { tag, value, from } of TAG_FALLBACKS) {
    read[tag] ??= from === undefined ? value : read[from]
  }

  return read
}

function holds(condition, tags) {
  return Object.entries(condition).every(([tag, value]) => tags[tag] === value)
}

function halvesOf(tags) {
  return holds(SPLIT.condition, tags) ? SPLIT.halves.map((direction) => ({ ...tags, direction })) : [tags]
}

// Every half a difference is read in must be placed by a row, or none is: a half no
// conditioned row matches would otherwise drop out of the union and soften the verdict.
function rowsFor(difference, tags) {
  const bound = boundOf(difference.before, difference.after)
  const applicable = ROWS.filter(
    (row) =>
      row.patterns.some((pattern) => matches(pattern, difference.pointer)) &&
      (row.bound === undefined || row.bound === bound),
  )
  const conditioned = applicable.filter((row) => row.condition !== undefined)
  const placed = halvesOf(withFallbacks(tags)).map((half) => conditioned.filter((row) => holds(row.condition, half)))

  if (conditioned.length > 0 && placed.some((rows) => rows.length === 0)) {
    return []
  }

  return applicable.filter((row) => row.condition === undefined || placed.some((rows) => rows.includes(row)))
}

// A difference is (pointer, direction, before, after); tags are the enclosing object's
// openness, write_openness, direction and layer as the contract states them, which rows 1
// through 4 read and every other row ignores.
export function classify(difference, tags = {}) {
  const rows = rowsFor(difference, tags)

  if (rows.length === 0) {
    return { verdict: 'undecidable', rows: [] }
  }

  const verdicts = rows.map((row) => row.cells[difference.direction] ?? 'undecidable')

  return { verdict: SPLIT.combine(verdicts), rows: rows.map((row) => row.row) }
}

const VERDICTS = new Set(['additive', 'writers-behind', 'breaking-readers', 'breaking-writers', 'breaking-both', 'undecidable', 'editorial'])

const DIRECTIONS = ['added', 'removed', 'changed', 'reordered']

const RULE_ROW = /^\|\s*(\d+[ab]?)\s*\|(.+)(?<!\\)\|\s*$/

const UNESCAPED_PIPE = /(?<!\\)\|/

const DELIMITER_ROW = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/

const ROW_NUMBER = /^[1-9][0-9]*[ab]?$/

const SECTION_HEADING = '## Rule table'

const FALLBACK_ROW = /^\|\s*`([a-z_]+)`\s*\|\s*(as\s+)?`([^`]+)`\s*\|\s*$/

const TAG_PAIR = /^([a-z_]+): (\S+)$/

const BOUND = /\b(raised|lowered|widened|narrowed)\b/

// A condition is a conjunction of tag pairs, so any word in a pointer class beyond its
// patterns, its pairs, its bound and these connectives is one this transcription cannot hold.
const CONNECTIVES = /\*\*|—|,|\b(?:where|and|the|same|bound|bounds|raised|lowered|widened|narrowed)\b/g

function quoted(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((held) => held[1])
}

function pairsIn(cell) {
  return Object.fromEntries(
    quoted(cell)
      .map((held) => TAG_PAIR.exec(held))
      .filter((pair) => pair !== null)
      .map((pair) => [pair[1], pair[2]]),
  )
}

function verdictsIn(cell) {
  return quoted(cell).filter((held) => VERDICTS.has(held))
}

function cellsOf(row) {
  return row.split(UNESCAPED_PIPE).map((cell) => cell.trim())
}

// Fenced blocks and HTML comments render as something other than the table, so a line inside
// one is never read as a heading or a row.
function linesOf(markdown) {
  let fenced = false
  let commented = false

  return markdown.split('\n').map((text, index) => {
    const fence = /^\s*(?:```|~~~)/.test(text)
    const line = { text, number: index + 1, hidden: fenced || commented || fence, opensFence: fence && !fenced }

    fenced = fence ? !fenced : fenced
    commented = commented ? !text.includes('-->') : text.includes('<!--') && !text.slice(text.indexOf('<!--')).includes('-->')

    return line
  })
}

// The section runs to the next heading of level one or two, so the editorial table under its
// own third-level heading is read as part of it.
function locate(markdown) {
  const lines = linesOf(markdown)
  const headings = lines.filter((line) => !line.hidden && line.text === SECTION_HEADING)

  if (headings.length === 0) {
    return undefined
  }

  const section = lines.slice(headings[0].number)
  const end = section.findIndex((line) => !line.hidden && /^#{1,2}\s/.test(line.text))

  return { section: end === -1 ? section : section.slice(0, end), headings: headings.length }
}

function visibleSection(markdown) {
  return (locate(markdown)?.section ?? []).filter((line) => !line.hidden).map((line) => line.text)
}

export function parseRuleTable(markdown) {
  const rows = new Map()
  let previous

  for (const line of visibleSection(markdown)) {
    const matched = RULE_ROW.exec(line)
    const cells = matched === null ? [] : cellsOf(matched[2])

    if (matched === null || cells.length !== 5) {
      continue
    }

    const stated = quoted(cells[0]).filter((held) => held.startsWith('/'))
    const inherits = /^the same\b/.test(cells[0]) && previous !== undefined
    const verdictCells = cells.slice(1)

    previous = {
      patterns: stated.length > 0 || !inherits ? stated : previous.patterns,
      condition: { ...(inherits ? previous.condition : {}), ...pairsIn(cells[0]) },
      bound: BOUND.exec(cells[0])?.[1] ?? (inherits ? previous.bound : undefined),
      stray: [
        ...cells[0].replace(/`[^`]*`/g, ' ').replace(CONNECTIVES, ' ').trim().split(/\s+/).filter((word) => word !== ''),
        ...quoted(cells[0]).filter((held) => !held.startsWith('/') && TAG_PAIR.exec(held) === null),
        ...Object.keys(pairsIn(cells[0])).filter(
          (tag) => quoted(cells[0]).filter((held) => TAG_PAIR.exec(held)?.[1] === tag).length > 1,
        ),
      ],
      crowded: DIRECTIONS.filter(
        (_direction, index) =>
          verdictsIn(verdictCells[index]).length > 1 ||
          Object.keys(pairsIn(verdictCells[index])).length > 0 ||
          (verdictsIn(verdictCells[index]).length === 1 && !/^`[^`]+`(\s+—.*)?$/.test(verdictCells[index])),
      ),
      combines: [...new Set(verdictCells[0].replace(/`[^`]*`/g, '').match(/\b\d+[ab]?\b/g) ?? [])],
      cells: Object.fromEntries(DIRECTIONS.map((direction, index) => [direction, verdictsIn(verdictCells[index])[0]])),
      combining: DIRECTIONS.filter((_direction, index) => /\bunion\b/.test(verdictCells[index].replace(/`[^`]*`/g, ''))),
    }
    rows.set(matched[1], previous)
  }

  return rows
}

export function parseFallbacks(markdown) {
  return markdown
    .split('\n')
    .map((line) => FALLBACK_ROW.exec(line))
    .filter((matched) => matched !== null)
    .map(([, tag, as, named]) => (as === undefined ? { tag, value: named } : { tag, from: named }))
}

function described(condition) {
  const pairs = Object.entries(condition ?? {}).map(([tag, value]) => `${tag}: ${value}`).sort()

  return pairs.length === 0 ? 'nothing' : pairs.join(', ')
}

function oneWay(listed, against) {
  return listed.filter((held) => !against.includes(held))
}

function shapeDisagreements(row, stated) {
  return [
    ...oneWay(row.patterns, stated.patterns).map((pattern) => `rule ${row.row} — the rule table does not name ${pattern}`),
    ...oneWay(stated.patterns, row.patterns).map((pattern) => `rule ${row.row} — the rule table names ${pattern}, which this does not hold`),
    ...(described(row.condition) === described(stated.condition)
      ? []
      : [`rule ${row.row} — the rule table conditions it on ${described(stated.condition)} and this holds ${described(row.condition)}`]),
    ...(row.bound === stated.bound
      ? []
      : [`rule ${row.row} — the rule table bounds it ${stated.bound ?? 'nowhere'} and this holds ${row.bound ?? 'no bound'}`]),
    ...(stated.stray.length === 0
      ? []
      : [`rule ${row.row} — the rule table words its condition with "${stated.stray.join(' ')}", which a conjunction of tags cannot hold`]),
  ]
}

function crowdedDisagreements(row, stated) {
  return stated.crowded.map((direction) => `rule ${row.row} — on ${direction} the rule table states more than one verdict, or a condition`)
}

function rowDisagreements(row, stated) {
  if (stated === undefined) {
    return [`rule ${row.row} — the rule table documents no row by that number`]
  }

  return [
    ...shapeDisagreements(row, stated),
    ...crowdedDisagreements(row, stated),
    ...DIRECTIONS.filter((direction) => (row.cells[direction] ?? undefined) !== stated.cells[direction]).map(
      (direction) =>
        `rule ${row.row} — on ${direction} the rule table says ${stated.cells[direction] ?? 'nothing'} and this holds ${row.cells[direction] ?? 'nothing'}`,
    ),
  ]
}

function splitDisagreements(stated) {
  if (stated === undefined) {
    return [`rule ${SPLIT.row} — the rule table documents no row by that number`]
  }

  const combinedRows = MEMBER_ROWS.filter((row) => SPLIT.halves.includes(row.condition.direction))
  const combined = combinedRows.map((row) => row.row)
  const held = (direction) => {
    const verdicts = [...new Set(combinedRows.map((row) => row.cells[direction]))]

    return verdicts.length === 1 ? verdicts[0] : SPLIT.combine.name
  }
  const says = (direction) =>
    stated.cells[direction] ?? (stated.combining.includes(direction) ? 'union' : undefined)

  return [
    ...shapeDisagreements(SPLIT, stated),
    ...crowdedDisagreements(SPLIT, stated),
    ...oneWay(combined, stated.combines).map((row) => `rule ${SPLIT.row} — the rule table does not combine row ${row}`),
    ...oneWay(stated.combines, combined).map((row) => `rule ${SPLIT.row} — the rule table combines row ${row}, which this does not`),
    ...DIRECTIONS.filter((direction) => held(direction) !== says(direction)).map(
      (direction) =>
        `rule ${SPLIT.row} — on ${direction} the rule table says ${says(direction) ?? 'nothing'} and this holds ${held(direction)}`,
    ),
  ]
}

function fallbackDisagreements(documented) {
  const named = (entry) => (entry.from === undefined ? `${entry.tag} as the value ${entry.value}` : `${entry.tag} as its ${entry.from}`)
  const ours = TAG_FALLBACKS.map(named)
  const theirs = documented.map(named)

  return [
    ...oneWay(ours, theirs).map((fallback) => `tag fallback — the rule table does not read ${fallback}`),
    ...oneWay(theirs, ours).map((fallback) => `tag fallback — the rule table reads ${fallback}, which this does not`),
  ]
}

function isEditorialRow(line) {
  const cells = cellsOf(line).slice(1, -1)

  return cells.length === 2 && quoted(cells[0]).some((held) => held.startsWith('/')) && quoted(cells[1])[0] === 'editorial'
}

function rowDisagreementsOf(line) {
  const number = /^\s*\|([^|]*)/.exec(line)?.[1]?.trim() ?? ''
  const matched = RULE_ROW.exec(line)

  if (/^[0-9]/.test(number) && !ROW_NUMBER.test(number)) {
    return [`rule ${number} — the rule table numbers a row in a shape this does not read: digits with no leading zero, then at most an a or a b`]
  }

  if (/^[0-9]/.test(number)) {
    return matched === null || cellsOf(matched[2]).length !== 5
      ? [`rule ${number} — the rule table states a row this cannot read as five cells`]
      : []
  }

  return isEditorialRow(line) ? [] : [`rule table — a line of the section this cannot read: ${JSON.stringify(line)}`]
}

function lineDisagreements(section) {
  return section.flatMap((line, index) => {
    if (!/^\s*\|/.test(line)) {
      return UNESCAPED_PIPE.test(line)
        ? [`rule table — a line of the section holds a pipe and does not open with one: ${JSON.stringify(line)}`]
        : []
    }

    return DELIMITER_ROW.test(line) || DELIMITER_ROW.test(section[index + 1] ?? '') ? [] : rowDisagreementsOf(line)
  })
}

function duplicateDisagreements(section) {
  const counted = new Map()

  for (const line of section) {
    const number = RULE_ROW.exec(line)?.[1]

    if (number !== undefined) {
      counted.set(number, (counted.get(number) ?? 0) + 1)
    }
  }

  return [...counted]
    .filter(([, count]) => count > 1)
    .map(([row]) => `rule ${row} — the rule table documents it more than once`)
}

function commentDisagreements(markdown) {
  return markdown
    .split('\n')
    .flatMap((line, index) =>
      line.includes('<!--')
        ? [`rule table — line ${index + 1} opens an HTML comment, which hides what it holds from a reader of the rendered document`]
        : [],
    )
}

function sectionDisagreements(markdown) {
  const located = locate(markdown)

  if (located === undefined) {
    return [`rule table — the document has no "${SECTION_HEADING}" heading, so it states no row this can read`]
  }

  const visible = located.section.filter((line) => !line.hidden).map((line) => line.text)

  return [
    ...(located.headings > 1 ? [`rule table — the document has more than one "${SECTION_HEADING}" heading`] : []),
    ...located.section
      .filter((line) => line.opensFence)
      .map((line) => `rule table — line ${line.number} opens a fenced block inside the section`),
    ...duplicateDisagreements(visible),
    ...lineDisagreements(visible),
  ]
}

// A row the table documents and this does not hold is safe only while no difference the job
// can find would land on it: the job would skip it and classify by the rows it does hold.
function documentedOnlyDisagreements(documented, compared) {
  const held = [...ROWS, SPLIT]
  const heldRows = new Set(held.map((row) => row.row))

  return [...documented]
    .filter(([row]) => !heldRows.has(row))
    .flatMap(([row, stated]) => {
      if (stated.patterns.length === 0) {
        return [`rule ${row} — the rule table states no pointer for it and it inherits none`]
      }

      return compared.flatMap((pointer) => {
        const owners = [...new Set(held.filter((entry) => entry.patterns.some((pattern) => matches(pattern, pointer))).map((entry) => entry.row))]

        return owners.length > 0 && stated.patterns.some((pattern) => matches(pattern, pointer))
          ? [`rule ${row} — the rule table places ${pointer}, which the drift watch compares and rule ${owners.join(', ')} classifies, and this holds no row ${row}`]
          : []
      })
    })
}

// The rows above are a transcription, and a transcription is only worth what checking it
// costs. Anything the job classifies is classified by a row this reports agreement on.
export function disagreements(markdown, compared) {
  const documented = parseRuleTable(markdown)

  return [
    ...sectionDisagreements(markdown),
    ...commentDisagreements(markdown),
    ...ROWS.flatMap((row) => rowDisagreements(row, documented.get(row.row))),
    ...splitDisagreements(documented.get(SPLIT.row)),
    ...documentedOnlyDisagreements(documented, compared),
    ...fallbackDisagreements(parseFallbacks(markdown)),
  ]
}
