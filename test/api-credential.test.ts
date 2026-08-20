import { describe, expect, it } from 'vitest'
import { createCronheartApi } from '../src/api/client.js'
import { ApiConfigurationError, isCronheartApiError } from '../src/api/errors.js'
import {
  API_KEY,
  BASE_URL,
  EVERY_CALL,
  FAILURE_MODES,
  SURFACES_PER_VALUE,
  apiWith,
  describeEverySurfaceOf,
} from './support/api-recorder.js'
import { callablesIn } from './support/surface.js'

const BASE = 'https://api.example'

// A delete reads no body, so a 200 carrying an unhydratable shape is a successful delete.
const MAKES_NO_REQUEST = 'rateLimit'

const ANSWERED_ANYWAY = [
  'channels.delete / wrong-shape',
  'monitors.delete / wrong-shape',
  ...FAILURE_MODES.map((mode) => `${MAKES_NO_REQUEST} / ${mode.id}`),
].sort()

// Derived the way the fault matrix derives its registry: a sweep compared against the ids
// of the very list it iterates cannot notice a route that was never added to that list.
async function everyRouteOnTheBuiltClient(): Promise<string[]> {
  const { createCronheartApi: built } = (await import(
    new URL('../dist/api.mjs', import.meta.url).href
  )) as { createCronheartApi: (options: unknown) => object }

  return callablesIn(
    built({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      env: {},
      fetch: () => new Promise(() => {}),
    }),
  ).sort()
}

describe('the credential is checked before a job can be running', () => {
  it('refuses a key that is missing, and names the variable that would supply it', () => {
    expect(() => createCronheartApi({ baseUrl: BASE, env: {} })).toThrow(ApiConfigurationError)

    try {
      createCronheartApi({ baseUrl: BASE, env: {} })
    } catch (error) {
      expect((error as Error).message).toContain('CRONHEART_API_KEY')
    }
  })

  it('refuses a key read out of a file with the newline still on it', () => {
    for (const shape of [`${API_KEY}\n`, ` ${API_KEY}`, `${API_KEY} `, `${API_KEY}\r\n`]) {
      expect(() => createCronheartApi({ apiKey: shape, baseUrl: BASE })).toThrow(
        ApiConfigurationError,
      )
    }
  })

  it('names the place the value it refused came from, not the other one', () => {
    const complaints = [
      () => createCronheartApi({ apiKey: 'nonsense', baseUrl: BASE, env: {} }),
      () => createCronheartApi({ baseUrl: BASE, env: { CRONHEART_API_KEY: 'nonsense' } }),
    ].map((build) => {
      try {
        build()

        return ''
      } catch (error) {
        return (error as Error).message
      }
    })

    expect(complaints[0]).toContain('apiKey option')
    expect(complaints[0]).not.toContain('CRONHEART_API_KEY')
    expect(complaints[1]).toContain('CRONHEART_API_KEY')
    expect(complaints[1]).not.toContain('apiKey option')
  })

  it('refuses a value that is not a key of this service at all', () => {
    const wrong = [
      '',
      'Bearer cmk_0000',
      '00000000-0000-4000-8000-000000000000',
      'cmk_',
      'cmk_short',
      `cmk_${'a'.repeat(20)}=`,
      `cmk_${'a'.repeat(20)}/${'b'.repeat(10)}`,
    ]

    for (const value of wrong) {
      expect(() => createCronheartApi({ apiKey: value, baseUrl: BASE })).toThrow(
        ApiConfigurationError,
      )
    }
  })

  it('takes the key from the environment when the caller passes none', () => {
    expect(() =>
      createCronheartApi({ baseUrl: BASE, env: { CRONHEART_API_KEY: API_KEY } }),
    ).not.toThrow()
  })

  it('refuses to carry the key over a transport that would show it to the network', () => {
    expect(() => createCronheartApi({ apiKey: API_KEY, baseUrl: 'http://api.example' })).toThrow(
      ApiConfigurationError,
    )
    expect(() =>
      createCronheartApi({ apiKey: API_KEY, baseUrl: 'http://localhost:8081' }),
    ).not.toThrow()
  })

  it('refuses a base URL that would move the request off the path it composed', () => {
    for (const baseUrl of [`${BASE}/?tenant=1`, `${BASE}/#x`, 'https://user:pw@api.example', 'not a url']) {
      expect(() => createCronheartApi({ apiKey: API_KEY, baseUrl })).toThrow(ApiConfigurationError)
    }
  })

  // The class assertion keeps this honest: without it the catch also catches the assertion
  // saying the refusal never happened, whose message satisfies an absence check.
  it('never rejects a base URL by quoting the credential inside it back', () => {
    try {
      createCronheartApi({ apiKey: API_KEY, baseUrl: `https://someone:${API_KEY}@api.example` })
      expect.unreachable('a credential in the base URL must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConfigurationError)
      expect((error as Error).message).not.toContain(API_KEY)
    }
  })
})

describe('the credential travels in one place only', () => {
  it('sends it as a bearer header and never as a query parameter', async () => {
    const { api, recorder } = apiWith({ status: 200, json: { data: [], total: 0, limit: 50, offset: 0 } })

    await api.monitors.list()

    const request = recorder.requests[0]

    expect(recorder.requests).toHaveLength(1)
    expect(request?.headers['Authorization']).toBe(`Bearer ${API_KEY}`)
    expect(request?.url).not.toContain(API_KEY)
    expect(new URL(String(request?.url)).search).toBe('?limit=50&offset=0')
  })

  it('sweeps every route the built client exposes, not the ones this file happens to list', async () => {
    expect(EVERY_CALL.map((call) => call.id).sort()).toEqual(await everyRouteOnTheBuiltClient())
  })

  it('keeps it out of every surface a failure is inspected through, on every route', async () => {
    const routes = await everyRouteOnTheBuiltClient()
    const leaks = await describeEverySurfaceOf()

    expect(leaks.routesThatFailed).toEqual(routes.filter((route) => route !== MAKES_NO_REQUEST))
    expect(leaks.surfacesInspected).toBe(
      FAILURE_MODES.length * routes.length * SURFACES_PER_VALUE,
    )
    expect(leaks.mentioningTheKey).toEqual([])
  })

  it('finds the key when it is there, so the sweep above is not looking at nothing', async () => {
    const leaks = await describeEverySurfaceOf({ leak: true })

    expect(leaks.mentioningTheKey.length).toBeGreaterThan(0)
  })

  it('keeps every failure inside the one type a caller catches', async () => {
    const routes = await everyRouteOnTheBuiltClient()
    const leaks = await describeEverySurfaceOf()

    expect(leaks.succeeded).toEqual(ANSWERED_ANYWAY)
    expect(leaks.failures).toHaveLength(
      FAILURE_MODES.length * routes.length - ANSWERED_ANYWAY.length,
    )
    expect(leaks.failures.filter((error) => !isCronheartApiError(error))).toEqual([])
  })
})
