import { DEFAULT_BASE_URL } from '../constants.js'
import { positiveOr } from '../numbers.js'
import { ambientEnv, numberFrom, readEnv } from '../ping/env.js'
import { attemptsFor } from '../transport/attempts.js'
import { userAgent } from '../version.js'
import { assertApiBaseUrl, assertUserAgent } from './config.js'
import { DEFAULT_API_TIMEOUT_MS } from './constants.js'
import { composed, plainOptions } from './compose.js'
import { ApiConfigurationError, isCronheartApiError } from './errors.js'
import { signupPollFrom, signupStartedFrom } from './hydrate.js'
import { type Endpoint, createSession } from './http.js'
import type { SignupClient, SignupClientOptions, StartSignupRequest } from './types.js'
import { assertDeviceCode, assertSignupEmail, assertTermsAccepted } from './validate.js'

const START_FIELDS: readonly string[] = ['email', 'accept_terms']

const POLL_FIELDS: readonly string[] = ['device_code']

function startEndpoint(request: StartSignupRequest): Endpoint {
  const { email, acceptTerms } = request

  assertSignupEmail(email)
  assertTermsAccepted(acceptTerms)

  return {
    method: 'POST',
    path: '/signup',
    retry: 'never',
    signupFlow: true,
    body: { email, accept_terms: true },
    problemFieldsKept: START_FIELDS,
  }
}

function pollEndpoint(deviceCode: string): Endpoint {
  assertDeviceCode(deviceCode)

  return {
    method: 'POST',
    path: '/signup/token',
    retry: 'never',
    signupFlow: true,
    body: { device_code: deviceCode },
    problemFieldsKept: POLL_FIELDS,
  }
}

export function createSignupClient(configuration: SignupClientOptions = {}): SignupClient {
  try {
    return build(configuration)
  } catch (error) {
    throw isCronheartApiError(error)
      ? error
      : new ApiConfigurationError(
          'cronheart: the options passed to createSignupClient could not be read.',
        )
  }
}

function build(configuration: SignupClientOptions): SignupClient {
  const env = configuration.env ?? ambientEnv()
  const configuredUrl = configuration.baseUrl ?? readEnv(env, 'URL') ?? DEFAULT_BASE_URL
  const agent = configuration.userAgent ?? userAgent()

  assertApiBaseUrl(configuredUrl)
  assertUserAgent(agent)

  // No key, and no repeat of either route: a start mails the address and spends its daily
  // allowance, and a poll answered with the token is never answered with it again.
  const session = createSession({
    baseUrl: configuredUrl.replace(/\/+$/, ''),
    apiKey: undefined,
    timeoutMs: positiveOr(
      configuration.timeoutMs ?? numberFrom(env, 'TIMEOUT_MS'),
      DEFAULT_API_TIMEOUT_MS,
    ),
    attempts: attemptsFor(0),
    userAgent: agent,
    fetch: configuration.fetch,
    signal: configuration.signal,
  })

  return {
    start: async (request, options) => {
      const composition = composed(() => ({ endpoint: startEndpoint(request), options: plainOptions(options) }))

      return signupStartedFrom(await session.send(composition.endpoint, composition.options))
    },
    poll: async (deviceCode, options) => {
      const composition = composed(() => ({ endpoint: pollEndpoint(deviceCode), options: plainOptions(options) }))
      const answered = await session.answer(composition.endpoint, composition.options)

      return signupPollFrom(answered.status, answered.value)
    },
  }
}
