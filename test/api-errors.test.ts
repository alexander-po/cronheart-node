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
import { errorForStatus } from '../src/api/classify.js'
import { PAID_ONLY_NOTICE } from '../src/api/tier.js'

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
    expect((error as ApiPlanRestrictionError).upgradeUrl).toBe('https://x.example')
  })

  it('names the fields a validation failure listed without pasting their messages in', () => {
    const error = classify(422, {
      errors: { name: 'This value is too short.', schedule_expr: 'Invalid cron expression.' },
    }) as ApiValidationError

    expect(error.message).toContain('name')
    expect(error.message).toContain('schedule_expr')
    expect(error.message).not.toContain('This value is too short.')
    expect(error.errors).toEqual({
      name: 'This value is too short.',
      schedule_expr: 'Invalid cron expression.',
    })
  })

  it('carries the retry guidance a rate limit came with, without inventing one', () => {
    const limited = classify(429, { retryAfterSeconds: 30 }) as ApiRateLimitError
    const bare = classify(429) as ApiRateLimitError

    expect(limited.retryAfterSeconds).toBe(30)
    expect(limited.message).toContain('30')
    expect(bare.retryAfterSeconds).toBeUndefined()
  })
})
