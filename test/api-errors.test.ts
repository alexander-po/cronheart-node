import { describe, expect, it } from 'vitest'
import {
  ApiAuthenticationError,
  ApiChannelDeliveryError,
  ApiConfigurationError,
  ApiConflictError,
  ApiForbiddenError,
  ApiHydrationError,
  ApiInvalidRequestError,
  ApiNotFoundError,
  ApiPlanRestrictionError,
  ApiRateLimitError,
  ApiTransportError,
  ApiUnexpectedResponseError,
  ApiValidationError,
  CronheartApiError,
  isCronheartApiError,
} from '../src/api/errors.js'
import type { AnyCronheartApiError } from '../src/api/errors.js'
import { errorForStatus } from '../src/api/classify.js'
import { PAID_ONLY_NOTICE } from '../src/api/tier.js'
import { ofKind } from './support/errors.js'

const WHERE = { method: 'GET', path: '/api/v1/monitors' } as const

function classify(status: number, problem = {}) {
  return errorForStatus(status, { ...blankProblem, ...problem }, WHERE, undefined)
}

const blankProblem = {
  status: undefined,
  title: undefined,
  detail: undefined,
  errors: undefined,
  upgradeUrl: undefined,
  retryAfterSeconds: undefined,
}

const EVERY_CLASS = [
  ApiAuthenticationError,
  ApiChannelDeliveryError,
  ApiConfigurationError,
  ApiConflictError,
  ApiForbiddenError,
  ApiHydrationError,
  ApiInvalidRequestError,
  ApiNotFoundError,
  ApiPlanRestrictionError,
  ApiRateLimitError,
  ApiTransportError,
  ApiUnexpectedResponseError,
  ApiValidationError,
]

describe('the error hierarchy', () => {
  it('roots every class it exports in the one type a caller catches', () => {
    expect(EVERY_CLASS.length).toBeGreaterThan(10)

    for (const Class of EVERY_CLASS) {
      expect(Object.create(Class.prototype)).toBeInstanceOf(CronheartApiError)
    }
  })

  it('gives every class a distinct kind, so a caller discriminates without instanceof', () => {
    const kinds = [
      classify(401).kind,
      classify(402).kind,
      classify(403).kind,
      classify(404).kind,
      classify(409).kind,
      classify(422).kind,
      classify(429).kind,
      classify(400).kind,
      new ApiTransportError('timeout', 'x').kind,
      new ApiHydrationError('x').kind,
      new ApiConfigurationError('x').kind,
      new ApiInvalidRequestError('x').kind,
      new ApiChannelDeliveryError('x', WHERE, blankProblem).kind,
    ]

    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('answers a brand check on an instance built by a second copy of the package', () => {
    const foreign = new (class extends Error {
      readonly kind = 'transport'
      constructor() {
        super('from another copy')
        Object.defineProperty(this, Symbol.for('cronheart.api.error'), { value: true })
      }
    })()

    expect(foreign).not.toBeInstanceOf(CronheartApiError)
    expect(isCronheartApiError(foreign)).toBe(true)
    expect(CronheartApiError.isCronheartApiError(foreign)).toBe(true)
  })

  it('refuses the brand to a plain error, so the check is not merely true of everything', () => {
    expect(isCronheartApiError(new Error('unrelated'))).toBe(false)
    expect(isCronheartApiError(undefined)).toBe(false)
    expect(isCronheartApiError({ kind: 'transport' })).toBe(false)
  })
})

describe('classification reads the status and nothing else', () => {
  it('maps each status the contract records to its own class', () => {
    expect(classify(401)).toBeInstanceOf(ApiAuthenticationError)
    expect(classify(402)).toBeInstanceOf(ApiPlanRestrictionError)
    expect(classify(403)).toBeInstanceOf(ApiForbiddenError)
    expect(classify(404)).toBeInstanceOf(ApiNotFoundError)
    expect(classify(409)).toBeInstanceOf(ApiConflictError)
    expect(classify(422)).toBeInstanceOf(ApiValidationError)
    expect(classify(429)).toBeInstanceOf(ApiRateLimitError)
    expect(classify(400)).toBeInstanceOf(ApiUnexpectedResponseError)
    expect(classify(500)).toBeInstanceOf(ApiUnexpectedResponseError)
    expect(classify(418)).toBeInstanceOf(ApiUnexpectedResponseError)
  })

  it('reaches the same class whatever prose the three conflicting conditions carry', () => {
    const conditions = [
      'A request with this Idempotency-Key is already in progress.',
      'This Idempotency-Key was already used with a different request.',
      'That channel kind is currently disabled.',
      '',
    ]
    const classified = conditions.map((detail) => classify(409, { detail }))

    expect(classified.map((error) => error.kind)).toEqual(conditions.map(() => 'conflict'))
    expect(new Set(classified.map((error) => error.message)).size).toBe(1)
  })

  it('never lets the server prose reach the message it composes', () => {
    const detail = 'Invalid credentials.'
    const errors = classify(401, { detail })

    expect(errors.problem?.detail).toBe(detail)
    expect(errors.message).not.toContain(detail)
  })

  it('answers a plan restriction with the sentence this package owns', () => {
    const error = classify(402, { detail: 'security.api.token_invalid', upgradeUrl: 'https://x.example' })

    expect(error.message).toContain(PAID_ONLY_NOTICE)
    expect(error.message).not.toContain('security.api.token_invalid')
    ofKind(error, 'plan-restriction')
    expect(error.upgradeUrl).toBe('https://x.example')
  })

  it('names the fields a validation failure listed without pasting their messages in', () => {
    const error = classify(422, {
      errors: { name: 'This value is too short.', schedule_expr: 'Invalid cron expression.' },
    })

    ofKind(error, 'validation')
    expect(error.message).toContain('name')
    expect(error.message).toContain('schedule_expr')
    expect(error.message).not.toContain('This value is too short.')
    expect(error.errors).toEqual({
      name: 'This value is too short.',
      schedule_expr: 'Invalid cron expression.',
    })
  })

  it('carries the retry guidance a rate limit came with, without inventing one', () => {
    const limited = classify(429, { retryAfterSeconds: 30 })
    const bare = classify(429)

    ofKind(limited, 'rate-limit')
    ofKind(bare, 'rate-limit')
    expect(limited.retryAfterSeconds).toBe(30)
    expect(limited.message).toContain('30')
    expect(bare.retryAfterSeconds).toBeUndefined()
  })
})

// Every field the README tells a caller to reach for after discriminating, read without a
// cast. It does not compile unless each subclass narrows the discriminant it inherits.
function afterDiscriminating(error: AnyCronheartApiError): string {
  if (error.kind === 'validation') {
    return Object.keys(error.errors).join(',')
  }

  if (error.kind === 'rate-limit') {
    return `retry-after ${String(error.retryAfterSeconds)}`
  }

  if (error.kind === 'plan-restriction') {
    return `upgrade ${String(error.upgradeUrl)}`
  }

  if (error.kind === 'transport') {
    return `transport ${error.reason}`
  }

  return error.kind
}

describe('what a caller can read once it has discriminated', () => {
  it('reaches every field the documented check-in leads to, without an instanceof or a cast', () => {
    expect(afterDiscriminating(classify(422, { errors: { name: 'too short', tz: 'unknown' } }))).toBe(
      'name,tz',
    )
    expect(afterDiscriminating(classify(429, { retryAfterSeconds: 30 }))).toBe('retry-after 30')
    expect(afterDiscriminating(classify(402, { upgradeUrl: 'https://x.example' }))).toBe(
      'upgrade https://x.example',
    )
    expect(afterDiscriminating(new ApiTransportError('timeout', 'x'))).toBe('transport timeout')
    expect(afterDiscriminating(new ApiTransportError('network-error', 'x'))).toBe(
      'transport network-error',
    )
    expect(afterDiscriminating(classify(404))).toBe('not-found')
  })

  it('groups the refusals the server answered with, so that class needs no instanceof either', () => {
    const refusals = [401, 402, 403, 404, 409, 422, 429, 400, 500].map((status) =>
      classify(status).group,
    )

    expect(new Set(refusals)).toEqual(new Set(['response']))
    expect(new ApiChannelDeliveryError('x', WHERE, blankProblem).group).toBe('response')
  })

  it('puts everything the server never answered outside that group', () => {
    expect(new ApiTransportError('timeout', 'x').group).toBe('transport')
    expect(new ApiHydrationError('x').group).toBe('hydration')
    expect(new ApiConfigurationError('x').group).toBe('configuration')
    expect(new ApiInvalidRequestError('x').group).toBe('invalid-request')
  })
})
