import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

const UNRESOLVED = Symbol('unresolved')
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/

const contract = JSON.parse(
  readFileSync(new URL('cronheart-contract.json', import.meta.url), 'utf8'),
)

function resolvePointer(pointer) {
  return pointer.split('/').slice(1).reduce(step, contract)
}

function step(node, token) {
  if (node === UNRESOLVED || node === null || typeof node !== 'object') {
    return UNRESOLVED
  }

  const key = token.replaceAll('~1', '/').replaceAll('~0', '~')

  if (Array.isArray(node)) {
    return ARRAY_INDEX.test(key) && Number(key) < node.length ? node[Number(key)] : UNRESOLVED
  }

  return Object.hasOwn(node, key) ? node[key] : UNRESOLVED
}

function problemWith(anchor, position) {
  if (typeof anchor.id !== 'string' || anchor.id === '') {
    return `${position} has no id`
  }

  if (typeof anchor.pointer !== 'string' || !anchor.pointer.startsWith('/')) {
    return `${anchor.id} has no JSON Pointer`
  }

  const resolved = resolvePointer(anchor.pointer)

  if (resolved === UNRESOLVED) {
    return `${anchor.id} — ${anchor.pointer} does not resolve`
  }

  if (Object.hasOwn(anchor, 'value') && !isDeepStrictEqual(resolved, anchor.value)) {
    return `${anchor.id} — ${anchor.pointer} is ${JSON.stringify(resolved)}, the contract states ${JSON.stringify(anchor.value)}`
  }

  return undefined
}

function inspect(anchor, position) {
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return { key: position, assertsValue: false, problem: `${position} is not an object` }
  }

  return {
    key: typeof anchor.id === 'string' && anchor.id !== '' ? anchor.id : position,
    assertsValue: Object.hasOwn(anchor, 'value'),
    problem: problemWith(anchor, position),
  }
}

// Anchors the SDK holds as constants, and the ones it deliberately does not yet.
// An anchor in neither list fails: adding one to the contract has to be a decision
// about the SDK, not a silent no-op.
const HELD_AS_CONSTANTS = {
  'ping.body.cap_bytes': 'PING_BODY_CAP_BYTES',
  'ping.uuid.pattern': 'PING_ROUTE_UUID_PATTERN',
  'ping.runtime_header.name': 'RUNTIME_HEADER_NAME',
  'ping.runtime_header.max_value': 'RUNTIME_HEADER_MAX_VALUE',
  'body_truncation.marker': 'PING_BODY_TRUNCATION_MARKER',
  'body_truncation.budget_bytes': 'PING_BODY_BUDGET_BYTES',
}

const DEFERRED = {
  'ping.action.pattern':
    'the SDK emits a closed union of literals and never builds the segment from a value, so the route pattern is a server-side gate it holds no constant for; the conformance vectors read it from this file',
  'ping.dedup.window_seconds':
    'server behaviour the ping path neither implements nor compensates for',
  'api.pagination.limit_max': 'management client',
  'api.pagination.limit_default': 'management client',
  'api.idempotency.ttl_seconds': 'management client',
  'constraints.monitor.name.max': 'management client',
  'constraints.grace.max': 'management client',
  'constraints.interval.min': 'management client',
  'constraints.interval.max': 'management client',
  'constraints.simple.allowlist': 'management client',
  'constraints.cron.field_count': 'management client',
  'vocabulary.snooze': 'management client',
  'vocabulary.channel_kind': 'management client',
  'vocabulary.monitor_status': 'management client',
  'vocabulary.ping_kind': 'management client',
  'vocabulary.plan_key': 'management client',
}

async function sdkConstants() {
  const built = new URL('../dist/index.mjs', import.meta.url)

  if (!existsSync(built)) {
    return undefined
  }

  return import(built.href)
}

function compareAgainstSdk(anchors, sdk) {
  return anchors.flatMap((anchor) => {
    const exportName = HELD_AS_CONSTANTS[anchor.id]

    if (exportName === undefined) {
      return Object.hasOwn(DEFERRED, anchor.id)
        ? []
        : [`${anchor.id} — no SDK constant holds it and it is not recorded as deferred`]
    }

    if (!Object.hasOwn(sdk, exportName)) {
      return [`${anchor.id} — the SDK no longer exports ${exportName}`]
    }

    const held = sdk[exportName]
    const stated = resolvePointer(anchor.pointer)

    return isDeepStrictEqual(held, stated)
      ? []
      : [
          `${anchor.id} — the SDK holds ${JSON.stringify(held)}, the contract states ${JSON.stringify(stated)}`,
        ]
  })
}

function report(failures) {
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`)
  }

  process.stderr.write(`contract check FAILED — ${failures.length} problem(s)\n`)
  process.exit(1)
}

const anchors = contract.anchors

if (!Array.isArray(anchors) || anchors.length === 0) {
  report(['"anchors" is missing, is not an array, or is empty'])
}

const outcomes = anchors.map((anchor, index) => inspect(anchor, `anchors[${index}]`))
const validated = new Map(outcomes.map((outcome) => [outcome.key, outcome]))

const failures = [
  ...(VERSION_SHAPE.test(contract.contract_version ?? '')
    ? []
    : ['"contract_version" is missing or is not a three-part version']),
  ...outcomes.map((outcome) => outcome.problem).filter((problem) => problem !== undefined),
  ...(validated.size === anchors.length
    ? []
    : [
        `validated ${validated.size} anchor(s) against ${anchors.length} entries — anchor ids must be unique`,
      ]),
]

if (failures.length > 0) {
  report(failures)
}

const valueAssertions = outcomes.filter((outcome) => outcome.assertsValue).length
const sdk = await sdkConstants()

if (sdk === undefined) {
  report(['dist/ is missing — build before checking the contract against the SDK'])
}

const drift = compareAgainstSdk(anchors, sdk)

if (drift.length > 0) {
  report(drift)
}

const held = Object.keys(HELD_AS_CONSTANTS).length

process.stdout.write(
  `contract ${contract.contract_version} — ${validated.size} anchor(s) resolved, ${valueAssertions} value assertion(s), ${held} held by the SDK, ${anchors.length - held} deferred — ok\n`,
)
