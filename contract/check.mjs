import { readFileSync } from 'node:fs'
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

process.stdout.write(
  `contract ${contract.contract_version} — ${validated.size} anchor(s) resolved, ${valueAssertions} value assertion(s) — ok\n`,
)
