import { baseUrlRefusal } from '../net/base-url.js'
import { API_TOKEN_PREFIX } from './constants.js'
import { ApiConfigurationError } from './errors.js'

// Deliberately looser than the length the service issues today, and deliberately strict
// about everything else: the failure this catches is a key read out of a file or a command
// substitution with whitespace still attached, which authenticates as a different string
// and then fails inside a running job rather than at boot.
const TOKEN_BODY = /^[A-Za-z0-9_-]{20,200}$/

function refuse(why: string): never {
  throw new ApiConfigurationError(`cronheart: ${why}`)
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

// Visible ASCII and spaces only, for the same reason an idempotency key is checked: this
// value is written into a header on every request the account's key travels on.
const USER_AGENT = /^[ -~]{1,200}$/

export function assertUserAgent(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !USER_AGENT.test(value)) {
    refuse(
      'the userAgent option is not something this client can put in a header. It is at most 200 visible ASCII characters, and a line break in one would inject a header of its own.',
    )
  }
}

export function assertApiBaseUrl(baseUrl: unknown): asserts baseUrl is string {
  if (typeof baseUrl !== 'string') {
    refuse(
      'the baseUrl option is not a string. The API path is appended to it, and a value of another shape is refused rather than coerced into an address nobody chose.',
    )
  }

  const refusal = baseUrlRefusal(baseUrl)

  if (refusal !== undefined) {
    refuse(`${refusal}. The API path is appended to it, and the key travels with every request.`)
  }
}
