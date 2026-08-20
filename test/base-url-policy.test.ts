import { describe, expect, it } from 'vitest'
import { createCronheartApi } from '../src/api/client.js'
import { ApiConfigurationError } from '../src/api/errors.js'
import { createPingClient } from '../src/ping/client.js'
import { InvalidBaseUrlError } from '../src/wiring/errors.js'
import { API_KEY, MONITOR_UUID } from './support/api-recorder.js'

// A secret the caller parked in the URL, assembled at runtime so no line here looks like one.
const PARKED = `hunter2-${'x'.repeat(12)}-not-real`

function buildPingClient(baseUrl: string): void {
  createPingClient({ baseUrl, env: {}, monitors: { job: MONITOR_UUID } })
}

function buildApiClient(baseUrl: string): void {
  createCronheartApi({ apiKey: API_KEY, baseUrl, env: {} })
}

const CLIENTS = [
  { id: 'the check-in client', build: buildPingClient, refusal: InvalidBaseUrlError },
  { id: 'the management client', build: buildApiClient, refusal: ApiConfigurationError },
] as const

// Every one passes an unanchored /^(localhost|127\.|\[::1\])/ prefix test, and any of them
// can be registered by whoever wants the credential the next request carries.
const NOT_LOOPBACK = [
  'http://localhost.attacker.example',
  'http://localhostile.example.com',
  'http://localhost-attacker.example',
  'http://127.attacker.example',
  'http://127.0.0.1.attacker.example',
  'http://1270.0.0.1',
]

// The parser folds case and normalises the short and decimal IPv4 forms first, so these
// are the same three addresses.
const LOOPBACK = [
  'http://localhost:8080',
  'http://LOCALHOST:8080',
  'http://127.0.0.1:9000',
  'http://127.1',
  'http://2130706433',
  'http://[::1]:9000',
]

describe.each(CLIENTS)('$id refuses plain http to a host that only looks like loopback', (client) => {
  it.each(NOT_LOOPBACK)('%s', (baseUrl) => {
    expect(() => client.build(baseUrl)).toThrow(client.refusal)
  })

  it.each(LOOPBACK)('but still allows the loopback a developer runs on: %s', (baseUrl) => {
    expect(() => client.build(baseUrl)).not.toThrow()
  })
})

describe.each(CLIENTS)('$id refuses a base URL without quoting what was parked in it', (client) => {
  it.each([
    `https://api.example/?token=${PARKED}`,
    `https://api.example/#${PARKED}`,
    `https://someone:${PARKED}@api.example`,
    `::: not a url ::: ${PARKED}`,
    `ftp://api.example/${PARKED}`,
  ])('%s', (baseUrl) => {
    try {
      client.build(baseUrl)
      expect.unreachable('the base URL must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(client.refusal)
      expect((error as Error).message).not.toContain(PARKED)
    }
  })

  it('still names the host it refused, so the message is worth reading', () => {
    try {
      client.build(`https://api.example/?token=${PARKED}`)
      expect.unreachable('the base URL must be refused')
    } catch (error) {
      expect((error as Error).message).toContain('api.example')
    }
  })
})
