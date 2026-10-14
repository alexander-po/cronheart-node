import type { ProblemDetails } from './types.js'

export const EMPTY_PROBLEM: ProblemDetails = {
  status: undefined,
  title: undefined,
  detail: undefined,
  errors: undefined,
  upgradeUrl: undefined,
  retryAfterSeconds: undefined,
}

const WITHHELD = "The service's message is withheld, because on this route it may repeat a credential or an address."

const IDENTIFIER_SHAPED =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i

function textOf(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]

  return typeof value === 'string' && value !== '' ? value : undefined
}

function integerOf(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function fieldErrorsOf(source: Record<string, unknown>): Readonly<Record<string, string>> | undefined {
  const value = source['errors']

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const collected: Record<string, string> = {}

  for (const [field, message] of Object.entries(value as Record<string, unknown>)) {
    if (typeof message === 'string') {
      collected[field] = message
    }
  }

  return Object.keys(collected).length === 0 ? undefined : collected
}

// Tolerant on purpose, and never keeping the raw text: an error body may be HTML from an
// edge proxy, or may echo the request back. What survives this function is a fixed set of
// typed fields, so nothing a caller did not send can reach a message or a log line.
export function parseProblem(body: string): ProblemDetails {
  let decoded: unknown

  try {
    decoded = JSON.parse(body)
  } catch {
    return EMPTY_PROBLEM
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return EMPTY_PROBLEM
  }

  const source = decoded as Record<string, unknown>

  return {
    status: integerOf(source, 'status'),
    title: textOf(source, 'title'),
    detail: textOf(source, 'detail'),
    errors: fieldErrorsOf(source),
    upgradeUrl: textOf(source, 'upgrade_url'),
    retryAfterSeconds: integerOf(source, 'retry_after'),
  }
}

function unlessIdentifier(text: string | undefined): string | undefined {
  return text === undefined || IDENTIFIER_SHAPED.test(text) ? undefined : text
}

// A field holding something shaped like an id is dropped whole rather than rewritten, since a
// rewrite can leave a broken address or two errors under one key.
export function withoutIdentifiers(problem: ProblemDetails): ProblemDetails {
  const errors = Object.entries(problem.errors ?? {}).filter(
    ([field, message]) => !IDENTIFIER_SHAPED.test(field) && !IDENTIFIER_SHAPED.test(message),
  )

  return {
    ...problem,
    title: unlessIdentifier(problem.title),
    detail: unlessIdentifier(problem.detail),
    upgradeUrl: unlessIdentifier(problem.upgradeUrl),
    errors: errors.length === 0 ? undefined : Object.fromEntries(errors),
  }
}

function isKept(field: string, kept: readonly string[]): boolean {
  const named = /^(.+?)(?:\.[0-9]{1,6}|\[[0-9]{1,6}\])?$/.exec(field)?.[1] ?? field

  return kept.includes(named)
}

// A destination, a monitor identifier, an address or a device code may be quoted back in any
// spelling and in any position, a field name included, so on the routes that carry one none of
// the service's prose is kept and only field names this client could have sent survive.
export function withheldText(problem: ProblemDetails, kept: readonly string[]): ProblemDetails {
  const fields = Object.keys(problem.errors ?? {}).filter((field) => isKept(field, kept))

  return {
    status: problem.status,
    retryAfterSeconds: problem.retryAfterSeconds,
    title: undefined,
    detail: undefined,
    upgradeUrl: undefined,
    errors:
      fields.length === 0
        ? undefined
        : Object.fromEntries(fields.map((field) => [field, WITHHELD])),
  }
}
