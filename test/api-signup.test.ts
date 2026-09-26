import { describe, expect, it } from 'vitest'
import {
  ApiConfigurationError,
  ApiForbiddenError,
  ApiHydrationError,
  ApiInvalidRequestError,
  ApiRateLimitError,
  ApiSignupExpiredError,
  ApiTransportError,
  ApiUnexpectedResponseError,
  isCronheartApiError,
} from '../src/api/errors.js'
import { createSignupClient } from '../src/api/signup.js'
import type { SignupClient, SignupClientOptions } from '../src/api/types.js'
import {
  API_KEY,
  type ApiStub,
  BASE_URL,
  FAILURE_MODES,
  type RecordedRequest,
  SURFACES_PER_VALUE,
  captureOutput,
  createApiRecorder,
  describeQuietly,
} from './support/api-recorder.js'
import { callablesIn } from './support/surface.js'

const DEVICE_CODE = 'device-code-held-by-this-terminal-alone'

const TOKEN = `cmk_${'7'.repeat(28)}synthetic`

const STARTED = {
  device_code: DEVICE_CODE,
  user_code: 'BCDF-GHJK',
  expires_in: 1800,
  interval: 5,
  hint: 'A hint for the caller.',
}

const ISSUED = { token: TOKEN, token_prefix: 'cmk_7777', project: 'default' }

const ADDRESS = 'someone@example.com'

function signupWith(
  stub: ApiStub | ((request: RecordedRequest, attempt: number) => ApiStub),
  overrides: SignupClientOptions = {},
): { client: SignupClient; requests: readonly RecordedRequest[] } {
  const recorder = createApiRecorder(stub)
  const client = createSignupClient({
    baseUrl: BASE_URL,
    env: {},
    fetch: recorder.fetch,
    ...overrides,
  })

  return { client, requests: recorder.requests }
}

async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call
  } catch (error) {
    return error
  }

  throw new Error('the call was expected to fail and did not')
}

describe('the signup client takes no key', () => {
  it('starts with the address and the acceptance, and nothing that authenticates', async () => {
    const { client, requests } = signupWith({ status: 202, json: STARTED }, {
      env: { CRONHEART_API_KEY: API_KEY },
    })

    await client.start({ email: ADDRESS, acceptTerms: true })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.url).toBe(`${BASE_URL}/api/v1/signup`)
    expect(requests[0]?.body).toBe(`{"email":"${ADDRESS}","accept_terms":true}`)
    expect(requests[0]?.headers['Content-Type']).toBe('application/json')
    expect(requests[0]?.headers['User-Agent']).toMatch(/^cronheart-node\//)
    expect(Object.keys(requests[0]?.headers ?? {})).not.toContain('Authorization')
  })

  it('polls with the device code in the body, never in the address', async () => {
    const { client, requests } = signupWith({ status: 202, json: { status: 'authorization_pending' } }, {
      env: { CRONHEART_API_KEY: API_KEY },
    })

    await client.poll(DEVICE_CODE)

    expect(requests[0]?.url).toBe(`${BASE_URL}/api/v1/signup/token`)
    expect(requests[0]?.body).toBe(`{"device_code":"${DEVICE_CODE}"}`)
    expect(Object.keys(requests[0]?.headers ?? {})).not.toContain('Authorization')
  })

  it('reads the service address from the environment when none is passed', async () => {
    const recorder = createApiRecorder({ status: 202, json: STARTED })
    const client = createSignupClient({
      env: { CRONHEART_URL: 'http://127.0.0.1:9' },
      fetch: recorder.fetch,
    })

    await client.start({ email: ADDRESS, acceptTerms: true })

    expect(recorder.requests[0]?.url).toBe('http://127.0.0.1:9/api/v1/signup')
  })

  it('refuses a base URL it would not send a key to either', () => {
    expect(() => createSignupClient({ baseUrl: 'http://api.example', env: {} })).toThrow(
      ApiConfigurationError,
    )
  })
})

describe('what the service is certain to refuse is refused before a request exists', () => {
  it.each([
    ['no acceptance', { email: ADDRESS }],
    ['an acceptance that is not true', { email: ADDRESS, acceptTerms: 'true' }],
    ['no address', { acceptTerms: true }],
    ['an empty address', { email: '', acceptTerms: true }],
    ['an address with no @', { email: 'someone.example.com', acceptTerms: true }],
    ['an address with two', { email: 'some@one@example.com', acceptTerms: true }],
    ['an address with a space', { email: 'some one@example.com', acceptTerms: true }],
    ['an address with a control character', { email: 'someone@example.com\u001b[2J', acceptTerms: true }],
    ['an address past the bound', { email: `${'a'.repeat(169)}@example.com`, acceptTerms: true }],
  ])('%s', async (_label, request) => {
    const { client, requests } = signupWith({ status: 202, json: STARTED })
    const error = await failureOf(client.start(request as never))

    expect(error).toBeInstanceOf(ApiInvalidRequestError)
    expect(requests).toEqual([])
    expect((error as Error).message).not.toContain('\u001b')
  })

  it('takes an address exactly at the bound', async () => {
    const { client, requests } = signupWith({ status: 202, json: STARTED })

    await client.start({ email: `${'a'.repeat(168)}@example.com`, acceptTerms: true })

    expect(requests).toHaveLength(1)
  })

  it('rejects a request it cannot read with its own type rather than a TypeError', async () => {
    const { client } = signupWith({ status: 202, json: STARTED })
    const hostile = Object.defineProperty({}, 'email', {
      get: () => {
        throw new TypeError('a getter that throws')
      },
    })

    for (const request of [null, undefined, hostile]) {
      expect(await failureOf(client.start(request as never))).toBeInstanceOf(ApiInvalidRequestError)
    }
  })

  it('refuses a poll without a device code', async () => {
    const { client, requests } = signupWith({ status: 202, json: {} })

    for (const code of ['', undefined, 42]) {
      expect(await failureOf(client.poll(code as never))).toBeInstanceOf(ApiInvalidRequestError)
    }

    expect(requests).toEqual([])
  })
})

describe('the answers', () => {
  it('reads the start answer the service publishes', async () => {
    const { client } = signupWith({ status: 202, json: STARTED })

    expect(await client.start({ email: ADDRESS, acceptTerms: true })).toEqual({
      deviceCode: DEVICE_CODE,
      userCode: 'BCDF-GHJK',
      expiresIn: 1800,
      interval: 5,
      hint: STARTED.hint,
    })
  })

  it('reads a 202 poll as pending and a 200 as the token', async () => {
    const pending = signupWith({ status: 202, json: { status: 'authorization_pending' } })
    const issued = signupWith({ status: 200, json: ISSUED })

    expect(await pending.client.poll(DEVICE_CODE)).toEqual({ status: 'pending' })
    expect(await issued.client.poll(DEVICE_CODE)).toEqual({
      status: 'issued',
      token: TOKEN,
      tokenPrefix: 'cmk_7777',
      project: 'default',
    })
  })

  it('raises a signup that is no longer open as a kind of its own', async () => {
    const { client } = signupWith({
      status: 410,
      json: { status: 410, error: 'expired_token', detail: 'Start again.' },
    })
    const error = await failureOf(client.poll(DEVICE_CODE))

    expect(error).toBeInstanceOf(ApiSignupExpiredError)
    expect(error).toMatchObject({ kind: 'signup-expired', group: 'response', status: 410 })
    expect((error as Error).message).toContain('start a new signup')
  })

  it('says a 403 on a signup route is signup switched off, not an account limit', async () => {
    const { client } = signupWith({ status: 403, json: { status: 403, error: 'signup_disabled' } })
    const error = await failureOf(client.start({ email: ADDRESS, acceptTerms: true }))

    expect(error).toBeInstanceOf(ApiForbiddenError)
    expect((error as Error).message).toContain('switched off')
    expect((error as Error).message).not.toContain('monitor limit')
  })

  it('carries the wait a 429 names, and does not blame an account rate limit', async () => {
    const { client } = signupWith({
      status: 429,
      json: { status: 429, error: 'slow_down' },
      headers: { 'retry-after': '5' },
    })
    const error = await failureOf(client.poll(DEVICE_CODE))

    expect(error).toBeInstanceOf(ApiRateLimitError)
    expect(error).toMatchObject({ retryAfterSeconds: 5 })
    expect((error as Error).message).toContain('signup')
    expect((error as Error).message).not.toContain('rate limit is exhausted')
  })
})

describe('neither route is ever repeated', () => {
  it.each([
    ['a connection that never opened', { rejectWith: new Error('socket hang up') }],
    ['a 500', { status: 500, body: 'upstream' }],
    ['a 503', { status: 503, json: { status: 503 } }],
  ])('on %s, even when the environment asks for retries', async (_label, stub) => {
    for (const call of [
      (client: SignupClient) => client.start({ email: ADDRESS, acceptTerms: true }),
      (client: SignupClient) => client.poll(DEVICE_CODE),
    ]) {
      const { client, requests } = signupWith(stub as ApiStub, {
        env: { CRONHEART_RETRIES: '5' },
      })
      const error = await failureOf(call(client))

      expect(isCronheartApiError(error)).toBe(true)
      expect(error instanceof ApiTransportError || error instanceof ApiUnexpectedResponseError).toBe(true)
      expect(requests).toHaveLength(1)
    }
  })
})

// The start answer hands out the device code and the poll answer the token, so each route
// gets a refused answer carrying its secret on top of the failures every route shares.
const REFUSED_ANSWERS: Readonly<Record<string, ApiStub>> = {
  start: { status: 202, json: { ...STARTED, user_code: 'not a code' } },
  poll: { status: 200, json: { ...ISSUED, token: `${TOKEN}\nCRONHEART_URL=http://elsewhere.invalid` } },
}

const CALLS: Readonly<Record<string, (client: SignupClient) => Promise<unknown>>> = {
  start: (client) => client.start({ email: ADDRESS, acceptTerms: true }),
  poll: (client) => client.poll(DEVICE_CODE),
}

// A fragment is enough to count: a message that quoted most of a secret would leak it too.
const FRAGMENT = 10

function carriesPartOf(surface: string, secret: string): boolean {
  for (let at = 0; at + FRAGMENT <= secret.length; at += 1) {
    if (surface.includes(secret.slice(at, at + FRAGMENT))) {
      return true
    }
  }

  return false
}

const LEAKY_CALLS: Readonly<Record<string, () => Promise<never>>> = {
  start: async () => {
    throw new ApiHydrationError(`the answer carried ${TOKEN.slice(0, 24)}`)
  },
  poll: async () => {
    console.warn(`polling with ${DEVICE_CODE.slice(8, 24)}`)

    throw new ApiTransportError('unexpected', 'the poll failed')
  },
}

const EVERY_PAIR = Object.keys(CALLS)
  .flatMap((route) => [...FAILURE_MODES.map((mode) => mode.id), 'refused-answer'].map((mode) => `${route} / ${mode}`))
  .sort()

async function routesOfTheBuiltClient(): Promise<string[]> {
  const { createSignupClient: built } = (await import(
    new URL('../dist/api.mjs', import.meta.url).href
  )) as { createSignupClient: (options: unknown) => object }

  return callablesIn(built({ baseUrl: BASE_URL, env: {}, fetch: () => new Promise(() => {}) })).sort()
}

async function secretsOnEverySurface({ leak = false } = {}): Promise<{
  readonly inspected: number
  readonly mentioning: readonly string[]
  readonly unbranded: readonly string[]
}> {
  const mentioning: string[] = []
  const unbranded: string[] = []
  let inspected = 0

  for (const [route, call] of Object.entries(CALLS)) {
    const modes = [...FAILURE_MODES, { id: 'refused-answer', stub: REFUSED_ANSWERS[route] ?? {} }]

    for (const mode of modes) {
      const { client } = signupWith(mode.stub)
      const capture = captureOutput()
      const subject = leak ? (LEAKY_CALLS[route] as () => Promise<never>) : () => call(client)
      let error: unknown

      try {
        error = await failureOf(subject()).catch((thrown: unknown) => thrown)
      } finally {
        capture.restore()
      }

      if (!isCronheartApiError(error)) {
        unbranded.push(`${route} / ${mode.id}`)
      }

      for (const surface of [...describeQuietly(error), capture.lines.join('\n')]) {
        inspected += 1

        if (carriesPartOf(surface, DEVICE_CODE) || carriesPartOf(surface, TOKEN)) {
          mentioning.push(`${route} / ${mode.id}`)
        }
      }
    }
  }

  return { inspected, mentioning: [...new Set(mentioning)].sort(), unbranded }
}

describe('the device code and the token stay out of every surface a failure is read through', () => {
  it('sweeps every route the built client exposes, not the ones this file happens to list', async () => {
    expect(Object.keys(CALLS).sort()).toEqual(await routesOfTheBuiltClient())
  })

  it('keeps both out, and every failure inside the one type a caller catches', async () => {
    const sweep = await secretsOnEverySurface()

    expect(sweep.inspected).toBe(EVERY_PAIR.length * SURFACES_PER_VALUE)
    expect(sweep.mentioning).toEqual([])
    expect(sweep.unbranded).toEqual([])
  })

  it('finds a fragment of either secret when one is there, so the sweep above is not looking at nothing', async () => {
    const sweep = await secretsOnEverySurface({ leak: true })

    expect(sweep.mentioning).toEqual(EVERY_PAIR)
  })

  it('refuses a user code or a token outside its shape without quoting it', async () => {
    for (const [route, stub] of Object.entries(REFUSED_ANSWERS)) {
      const error = await failureOf((CALLS[route] as (client: SignupClient) => Promise<unknown>)(signupWith(stub).client))

      expect(error).toBeInstanceOf(ApiHydrationError)
      expect((error as Error).message).not.toContain('not a code')
      expect((error as Error).message).not.toContain('elsewhere.invalid')
    }
  })
})
