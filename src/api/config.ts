import { API_TOKEN_PREFIX } from './constants.js'
import { ApiConfigurationError } from './errors.js'

const LOOPBACK = /^(localhost|127\.|\[::1\])/i

// Deliberately looser than the length the service issues today, and deliberately strict
// about everything else: the failure this catches is a key read out of a file or a command
// substitution with whitespace still attached, which authenticates as a different string
// and then fails inside a running job rather than at boot.
const TOKEN_BODY = /^[A-Za-z0-9_-]{20,200}$/

function refuse(why: string): never {
  throw new ApiConfigurationError(`cronheart: ${why}`)
}

function withoutUserinfo(baseUrl: string): string {
  return baseUrl.replace(/\/\/[^/@]*@/, '//')
}

export function assertApiKey(value: unknown, source: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    refuse(
      `no API key. Pass apiKey to createCronheartApi, or set ${source} — a key is created on the account's API tokens page.`,
    )
  }

  if (!value.startsWith(API_TOKEN_PREFIX) || !TOKEN_BODY.test(value.slice(API_TOKEN_PREFIX.length))) {
    refuse(
      `the value ${source} carries is not a Cronheart API key. A key begins ${API_TOKEN_PREFIX} and carries nothing but letters, digits, hyphens and underscores after it — a key read from a file usually still has its trailing newline attached.`,
    )
  }
}

export function assertApiBaseUrl(baseUrl: string): void {
  const refuseUrl = (why: string): never =>
    refuse(
      `${JSON.stringify(withoutUserinfo(baseUrl))} cannot be the API base URL — ${why}. The API path is appended to it, and the key travels with every request.`,
    )
  let parsed: URL

  try {
    parsed = new URL(baseUrl)
  } catch {
    return refuseUrl('it is not a URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    refuseUrl('it is not http or https')
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    refuseUrl('it carries a query string or a fragment')
  }

  if (parsed.username !== '' || parsed.password !== '') {
    refuseUrl('it carries a credential of its own')
  }

  if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname)) {
    refuseUrl('plain http would put the API key on the wire in the clear')
  }
}
