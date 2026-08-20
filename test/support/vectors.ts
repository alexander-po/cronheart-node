import { readFileSync, readdirSync } from 'node:fs'

export interface VectorAssertion {
  readonly predicate: string
  readonly path?: string
  readonly value?: unknown
}

export interface VectorCase {
  readonly id: string
  readonly subject?: string
  readonly input: unknown
  readonly expect: readonly VectorAssertion[]
  readonly why?: string
  readonly optional?: boolean
}

export interface VectorFile {
  readonly name: string
  readonly contract_version: string
  readonly group: string
  readonly default_subject?: string
  readonly case_count: number
  readonly cases: readonly VectorCase[]
}

export type Subject = (input: unknown) => unknown

export interface Adapter {
  readonly subjects: Readonly<Record<string, Subject>>
  readonly errorClasses: Readonly<Record<string, abstract new (...args: never[]) => Error>>
}

const PREDICATES = new Set([
  'equals',
  'byteLength',
  'matches',
  'isErrorClass',
  'rejects',
  'throwsNothing',
])

export function loadVectorFiles(directory: URL): VectorFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort()
    .map((name) => ({
      name,
      ...(JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as Omit<VectorFile, 'name'>),
    }))
}

export function encodeByteString(input: unknown): string {
  const parts = (input as { parts?: readonly Record<string, unknown>[] }).parts ?? []

  return parts
    .map((part) =>
      typeof part['literal'] === 'string'
        ? part['literal']
        : String(part['repeat']).repeat(Number(part['times'])),
    )
    .join('')
}

function pointInto(result: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === '') {
    return result
  }

  return pointer
    .split('/')
    .slice(1)
    .reduce<unknown>((node, token) => {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~')

      return node === null || typeof node !== 'object'
        ? undefined
        : (node as Record<string, unknown>)[key]
    }, result)
}

function describe(value: unknown): string {
  return typeof value === 'string' && value.length > 60
    ? `${JSON.stringify(value.slice(0, 60))}… (${value.length} chars)`
    : JSON.stringify(value)
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return (
      actual.length === expected.length &&
      actual.every((item, index) => sameValue(item, expected[index]))
    )
  }

  return Object.is(actual, expected)
}

interface Settled {
  readonly threw: boolean
  readonly error: unknown
  readonly result: unknown
}

async function settle(subject: Subject, input: unknown): Promise<Settled> {
  try {
    return { threw: false, error: undefined, result: await subject(input) }
  } catch (error) {
    return { threw: true, error, result: undefined }
  }
}

function checkOne(
  assertion: VectorAssertion,
  settled: Settled,
  adapter: Adapter,
): string | undefined {
  if (!PREDICATES.has(assertion.predicate)) {
    return `unknown predicate ${JSON.stringify(assertion.predicate)}`
  }

  if (assertion.predicate === 'rejects') {
    return settled.threw ? undefined : 'expected the subject to throw, it returned'
  }

  if (assertion.predicate === 'throwsNothing') {
    return settled.threw ? `expected no throw, got ${String(settled.error)}` : undefined
  }

  if (assertion.predicate === 'isErrorClass') {
    const expected = adapter.errorClasses[String(assertion.value)]

    if (expected === undefined) {
      return `no local class is mapped to contract error class ${JSON.stringify(assertion.value)}`
    }

    if (!settled.threw) {
      return 'expected the subject to throw, it returned'
    }

    return settled.error instanceof expected
      ? undefined
      : `expected error class ${String(assertion.value)}, got ${String(settled.error)}`
  }

  if (settled.threw) {
    return `expected a value, the subject threw ${String(settled.error)}`
  }

  const actual = pointInto(settled.result, assertion.path)

  if (assertion.predicate === 'equals') {
    return sameValue(actual, assertion.value)
      ? undefined
      : `at ${assertion.path === '' ? '<result>' : assertion.path}: expected ${describe(assertion.value)}, got ${describe(actual)}`
  }

  if (assertion.predicate === 'byteLength') {
    if (typeof actual !== 'string') {
      return `byteLength needs a string, got ${describe(actual)}`
    }

    const bytes = new TextEncoder().encode(actual).length

    return bytes === assertion.value
      ? undefined
      : `expected ${String(assertion.value)} UTF-8 bytes, got ${bytes}`
  }

  if (typeof actual !== 'string') {
    return `matches needs a string, got ${describe(actual)}`
  }

  return new RegExp(String(assertion.value), 'u').test(actual)
    ? undefined
    : `expected a match for ${describe(assertion.value)}, got ${describe(actual)}`
}

export interface CaseOutcome {
  readonly executed: boolean
  readonly failures: readonly string[]
}

export async function runCase(
  vectorCase: VectorCase,
  defaultSubject: string | undefined,
  adapter: Adapter,
): Promise<CaseOutcome> {
  const name = vectorCase.subject ?? defaultSubject
  const subject = name === undefined ? undefined : adapter.subjects[name]

  if (subject === undefined) {
    if (vectorCase.optional === true) {
      return { executed: false, failures: [] }
    }

    return {
      executed: true,
      failures: [`unknown subject ${JSON.stringify(name)} and the case is not optional`],
    }
  }

  if (vectorCase.expect.length === 0) {
    return { executed: true, failures: ['a case must carry at least one assertion'] }
  }

  const settled = await settle(subject, vectorCase.input)

  return {
    executed: true,
    failures: vectorCase.expect
      .map((assertion) => checkOne(assertion, settled, adapter))
      .filter((failure): failure is string => failure !== undefined),
  }
}
