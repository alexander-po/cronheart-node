import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { classify, disagreements } from './classify.mjs'

const UNRESOLVED = Symbol('unresolved')
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

const MOVED = 3

// Each entry names a contract pointer and how to read the same fact out of the published
// specification. `members` is compared as a set plus an order; `value` is compared whole,
// which is what keeps a type union from being read as a list losing one of its members.
const FACTS = [
  ['/api/constraints/monitor.name/min_length', 'value', (doc) => property(doc, 'MonitorCreate', 'name')?.minLength],
  ['/api/constraints/monitor.name/max_length', 'value', (doc) => property(doc, 'MonitorCreate', 'name')?.maxLength],
  ['/api/constraints/monitor.schedule_expr/max_length', 'value', (doc) => property(doc, 'MonitorCreate', 'schedule_expr')?.maxLength],
  ['/api/constraints/monitor.tz/default', 'value', (doc) => property(doc, 'MonitorCreate', 'tz')?.default],
  ['/api/constraints/monitor.grace_seconds/min', 'value', (doc) => property(doc, 'MonitorCreate', 'grace_seconds')?.minimum],
  ['/api/constraints/monitor.grace_seconds/max', 'value', (doc) => property(doc, 'MonitorCreate', 'grace_seconds')?.maximum],
  ['/api/constraints/monitor.grace_seconds/default', 'value', (doc) => property(doc, 'MonitorCreate', 'grace_seconds')?.default],
  ['/api/constraints/channel.label/min_length', 'value', (doc) => property(doc, 'ChannelCreate', 'label')?.minLength],
  ['/api/constraints/channel.label/max_length', 'value', (doc) => property(doc, 'ChannelCreate', 'label')?.maxLength],
  ['/api/constraints/snooze.duration/required', 'value', (doc) => schema(doc, 'Snooze')?.required?.includes('duration')],

  ['/vocabularies/monitor.status/members', 'members', (doc) => property(doc, 'Monitor', 'status')?.enum],
  ['/vocabularies/schedule.kind/members', 'members', (doc) => property(doc, 'Monitor', 'schedule_kind')?.enum],
  ['/vocabularies/channel.kind/members', 'members', (doc) => property(doc, 'Channel', 'kind')?.enum],
  ['/vocabularies/alert.kind/members', 'members', (doc) => property(doc, 'Alert', 'kind')?.enum],
  ['/vocabularies/ping.kind/members', 'members', (doc) => property(doc, 'Ping', 'kind')?.enum],
  ['/vocabularies/snooze.duration/members', 'members', (doc) => property(doc, 'Snooze', 'duration')?.enum],

  ['/api/pagination/limit_clamp/min', 'value', (doc) => queryParameter(doc, '/api/v1/monitors', 'limit')?.schema?.minimum],
  ['/api/pagination/limit_clamp/max', 'value', (doc) => queryParameter(doc, '/api/v1/monitors', 'limit')?.schema?.maximum],
  ['/api/pagination/limit_clamp/default', 'value', (doc) => queryParameter(doc, '/api/v1/monitors', 'limit')?.schema?.default],
  ['/api/pagination/offset_clamp/min', 'value', (doc) => queryParameter(doc, '/api/v1/monitors', 'offset')?.schema?.minimum],
  ['/api/pagination/shapes/0/response_keys', 'members', (doc) => keysOf(doc, 'MonitorList')],
  ['/api/pagination/shapes/1/response_keys', 'members', (doc) => keysOf(doc, 'PingList')],
  ['/api/pagination/shapes/2/response_keys', 'members', (doc) => keysOf(doc, 'ChannelList')],
  ['/api/pagination/shapes/0/request_params', 'members', (doc) => queryNames(doc, '/api/v1/monitors')],
  ['/api/pagination/shapes/1/request_params', 'members', (doc) => queryNames(doc, '/api/v1/monitors/{uuid}/pings')],
  ['/api/pagination/shapes/2/request_params', 'members', (doc) => queryNames(doc, '/api/v1/channels')],

  ['/api/identifiers/monitor/read_type', 'value', (doc) => property(doc, 'Monitor', 'uuid')?.type],
  ['/api/identifiers/monitor/format', 'value', (doc) => property(doc, 'Monitor', 'uuid')?.format],
  ['/api/identifiers/channel/read_type', 'value', (doc) => property(doc, 'Channel', 'id')?.type],
  ['/api/identifiers/channel/write_type', 'value', (doc) => property(doc, 'MonitorCreate', 'channel_ids')?.items?.type],
  ['/api/identifiers/ping/read_type', 'value', (doc) => property(doc, 'Ping', 'id')?.type],
  ['/api/identifiers/alert/read_type', 'value', (doc) => property(doc, 'Alert', 'id')?.type],

  ['/api/read_shapes/monitor/keys', 'members', (doc) => keysOf(doc, 'Monitor')],
  ['/api/read_shapes/monitor.channels[]/keys', 'members', (doc) => keysOf(doc, 'MonitorChannel')],
  ['/api/read_shapes/channel/keys', 'members', (doc) => keysOf(doc, 'Channel')],
  ['/api/read_shapes/ping/keys', 'members', (doc) => keysOf(doc, 'Ping')],
  ['/api/read_shapes/alert/keys', 'members', (doc) => keysOf(doc, 'Alert')],
  ['/api/read_shapes/account/keys', 'members', (doc) => keysOf(doc, 'Account')],
  ['/api/read_shapes/monitor/nullable', 'members', (doc) => nullableOf(doc, 'Monitor')],
  ['/api/read_shapes/ping/nullable', 'members', (doc) => nullableOf(doc, 'Ping')],
  ['/api/read_shapes/alert/nullable', 'members', (doc) => nullableOf(doc, 'Alert')],
]

function schema(document, name) {
  return document?.components?.schemas?.[name]
}

function property(document, name, key) {
  return schema(document, name)?.properties?.[key]
}

function keysOf(document, name) {
  const properties = schema(document, name)?.properties

  return properties === undefined ? undefined : Object.keys(properties)
}

function nullableOf(document, name) {
  const properties = schema(document, name)?.properties

  return properties === undefined
    ? undefined
    : Object.entries(properties)
        .filter(([, held]) => Array.isArray(held?.type) && held.type.includes('null'))
        .map(([key]) => key)
}

function parametersOf(document, path) {
  const held = document?.paths?.[path]?.get?.parameters

  return Array.isArray(held) ? held : []
}

function queryParameter(document, path, name) {
  return parametersOf(document, path).find(
    (parameter) => parameter?.in === 'query' && parameter?.name === name,
  )
}

function queryNames(document, path) {
  return document?.paths?.[path]?.get === undefined
    ? undefined
    : parametersOf(document, path)
        .filter((parameter) => parameter?.in === 'query')
        .map((parameter) => parameter?.name)
}

export function project(document) {
  const facts = {}

  for (const [pointer, , read] of FACTS) {
    const value = read(document)

    if (value !== undefined) {
      facts[pointer] = value
    }
  }

  return facts
}

function resolve(contract, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .reduce((node, token) => {
      if (node === UNRESOLVED || node === null || typeof node !== 'object') {
        return UNRESOLVED
      }

      const key = token.replaceAll('~1', '/').replaceAll('~0', '~')

      if (Array.isArray(node)) {
        return ARRAY_INDEX.test(key) && Number(key) < node.length ? node[Number(key)] : UNRESOLVED
      }

      return Object.hasOwn(node, key) ? node[key] : UNRESOLVED
    }, contract)
}

// The contract is what this package believes and the snapshot is what the service publishes,
// so the snapshot is the later document: a member only it holds was added, and one only the
// contract holds was removed. Reading the pair the other way round inverts every verdict.
function differencesAt(pointer, shape, believed, published) {
  if (shape === 'members' && Array.isArray(believed) && Array.isArray(published)) {
    const added = published.filter((member) => !believed.includes(member))
    const removed = believed.filter((member) => !published.includes(member))

    if (added.length === 0 && removed.length === 0) {
      return isDeepStrictEqual(believed, published)
        ? []
        : [{ pointer, direction: 'reordered', before: believed, after: published, members: [] }]
    }

    return [
      ...(added.length === 0 ? [] : [{ pointer, direction: 'added', before: believed, after: published, members: added }]),
      ...(removed.length === 0 ? [] : [{ pointer, direction: 'removed', before: believed, after: published, members: removed }]),
    ]
  }

  return isDeepStrictEqual(believed, published)
    ? []
    : [{ pointer, direction: 'changed', before: believed, after: published, members: [] }]
}

function tagsFor(contract, pointer) {
  const owner = resolve(contract, pointer.split('/').slice(0, -1).join('/'))

  if (owner === UNRESOLVED || owner === null || typeof owner !== 'object') {
    return {}
  }

  return { openness: owner.openness, direction: owner.direction, layer: owner.layer ?? 'server' }
}

export function compare(contract, facts) {
  const findings = []

  for (const [pointer, shape] of FACTS) {
    const published = facts[pointer]
    const believed = resolve(contract, pointer)

    if (published === undefined) {
      findings.push({
        pointer,
        verdict: 'unreadable',
        rows: [],
        detail: 'the published specification states nothing here, so nothing checks this fact',
      })

      continue
    }

    if (believed === UNRESOLVED) {
      findings.push({
        pointer,
        verdict: 'undecidable',
        rows: [],
        detail: 'the contract states nothing here, so the rules have no class to place it in',
      })

      continue
    }

    for (const difference of differencesAt(pointer, shape, believed, published)) {
      const placed = classify(difference, tagsFor(contract, pointer))

      findings.push({
        pointer,
        verdict: placed.verdict,
        rows: placed.rows,
        detail: detailOf(difference),
      })
    }
  }

  return findings
}

function detailOf(difference) {
  if (difference.members.length > 0) {
    return `${difference.direction} ${difference.members.map((member) => JSON.stringify(member)).join(', ')}`
  }

  return `${difference.direction} — the contract states ${JSON.stringify(difference.before)}, the specification publishes ${JSON.stringify(difference.after)}`
}

function argumentAfter(argv, flag, fallback) {
  const at = argv.indexOf(flag)

  return at === -1 || argv[at + 1] === undefined || argv[at + 1].startsWith('--') ? fallback : argv[at + 1]
}

async function main(argv) {
  const out = []
  const contractPath = argumentAfter(argv, '--contract', new URL('cronheart-contract.json', import.meta.url))
  const snapshotPath = argumentAfter(argv, '--snapshot', new URL('server-snapshot.json', import.meta.url))
  const rulesPath = argumentAfter(argv, '--rules', new URL('CLASSIFICATION.md', import.meta.url))
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  const live = argv.includes('--live')
  const drifted = disagreements(readFileSync(rulesPath, 'utf8'))

  if (drifted.length > 0) {
    throw new Error(`the classifier and the documented rule table disagree:\n  - ${drifted.join('\n  - ')}`)
  }

  let facts = snapshot.facts
  let moved = false

  if (live) {
    const source = argumentAfter(argv, '--source', snapshot.source)
    const response = await fetch(source, { headers: { accept: 'application/json' } })

    if (!response.ok) {
      throw new Error(`${source} answered ${response.status}`)
    }

    facts = project(await response.json())
    moved = !isDeepStrictEqual(facts, snapshot.facts)

    if (moved) {
      const captured_on = new Date().toISOString().slice(0, 10)

      writeFileSync(snapshotPath, `${JSON.stringify({ ...snapshot, captured_on, facts }, null, 2)}\n`)
    }
  }

  const findings = compare(contract, facts)
  const failing = findings.filter((finding) => finding.verdict !== 'additive')

  out.push(
    `contract drift — ${Object.keys(facts).length} fact(s) compared against contract ${contract.contract_version}, ${live ? 'fetched live' : `snapshot captured on ${snapshot.captured_on}`}`,
  )

  for (const finding of findings) {
    out.push(
      `  ${finding.verdict === 'additive' ? '.' : '!'} ${finding.pointer} — ${finding.detail} — ${finding.verdict}${finding.rows.length === 0 ? '' : ` (rule ${finding.rows.join(', ')})`}`,
    )
  }

  if (findings.length === 0) {
    out.push('  no difference between the contract and what the specification publishes')
  }

  out.push('what this cannot see, in the contract’s own words:')

  for (const gap of contract.api?.openapi_document?.does_not_cover ?? []) {
    out.push(`  - ${gap}`)
  }

  if (moved) {
    out.push('the published specification has moved — open a pull request with the rewritten snapshot')
  }

  process.stdout.write(`${out.join('\n')}\n`)

  return moved ? MOVED : failing.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`contract drift FAILED — ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
