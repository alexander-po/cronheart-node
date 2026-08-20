import type { ProblemDetails } from './types.js'

export const EMPTY_PROBLEM: ProblemDetails = {
  status: undefined,
  title: undefined,
  detail: undefined,
  errors: undefined,
  upgradeUrl: undefined,
  retryAfterSeconds: undefined,
}

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
