import type { ProblemDetails, RateLimitSnapshot } from './types.js'

export type ApiErrorKind =
  | 'configuration'
  | 'invalid-request'
  | 'transport'
  | 'hydration'
  | 'authentication'
  | 'plan-restriction'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'validation'
  | 'rate-limit'
  | 'channel-delivery'
  | 'unexpected'

export type ApiTransportReason =
  | 'timeout'
  | 'aborted'
  | 'network-error'
  | 'unparseable'
  | 'unbounded'
  | 'unexpected'

export interface RequestDescriptor {
  readonly method: string
  // The path only. A query string would carry a pagination cursor into every log line, and
  // a credential must never be in one to begin with.
  readonly path: string
  readonly deliversDownstream?: boolean | undefined
}

// Symbol.for rather than a private symbol, and unversioned: two copies of this package in
// one dependency tree have different classes, so instanceof silently answers false for an
// error the other copy threw. The registry is the one thing both copies share.
const BRAND = Symbol.for('cronheart.api.error')

export interface ApiErrorDetails {
  readonly status?: number | undefined
  readonly problem?: ProblemDetails | undefined
  readonly request?: RequestDescriptor | undefined
  readonly rateLimit?: RateLimitSnapshot | undefined
  readonly cause?: unknown
}

export class CronheartApiError extends Error {
  override readonly name: string = 'CronheartApiError'

  readonly kind: ApiErrorKind

  readonly status: number | undefined

  readonly problem: ProblemDetails | undefined

  readonly request: RequestDescriptor | undefined

  readonly rateLimit: RateLimitSnapshot | undefined

  constructor(kind: ApiErrorKind, message: string, details: ApiErrorDetails = {}) {
    super(message, 'cause' in details ? { cause: details.cause } : undefined)
    this.kind = kind
    this.status = details.status
    this.problem = details.problem
    this.request = details.request
    this.rateLimit = details.rateLimit
    Object.defineProperty(this, BRAND, { value: true, enumerable: false })
  }

  static isCronheartApiError(value: unknown): value is CronheartApiError {
    return isCronheartApiError(value)
  }
}

export function isCronheartApiError(value: unknown): value is CronheartApiError {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    return (value as Record<symbol, unknown>)[BRAND] === true
  } catch {
    return false
  }
}

export class ApiConfigurationError extends CronheartApiError {
  override readonly name: string = 'ApiConfigurationError'

  constructor(message: string) {
    super('configuration', message)
  }
}

export class ApiInvalidRequestError extends CronheartApiError {
  override readonly name: string = 'ApiInvalidRequestError'

  constructor(message: string) {
    super('invalid-request', message)
  }
}

export class ApiTransportError extends CronheartApiError {
  override readonly name: string = 'ApiTransportError'

  readonly reason: ApiTransportReason

  constructor(reason: ApiTransportReason, message: string, details: ApiErrorDetails = {}) {
    super('transport', message, details)
    this.reason = reason
  }
}

export class ApiHydrationError extends CronheartApiError {
  override readonly name: string = 'ApiHydrationError'

  constructor(message: string, details: ApiErrorDetails = {}) {
    super('hydration', message, details)
  }
}

export class ApiResponseError extends CronheartApiError {
  override readonly name: string = 'ApiResponseError'
}

export class ApiAuthenticationError extends ApiResponseError {
  override readonly name: string = 'ApiAuthenticationError'

  constructor(message: string, details: ApiErrorDetails) {
    super('authentication', message, details)
  }
}

export class ApiPlanRestrictionError extends ApiResponseError {
  override readonly name: string = 'ApiPlanRestrictionError'

  readonly upgradeUrl: string | undefined

  constructor(message: string, details: ApiErrorDetails) {
    super('plan-restriction', message, details)
    this.upgradeUrl = details.problem?.upgradeUrl
  }
}

export class ApiForbiddenError extends ApiResponseError {
  override readonly name: string = 'ApiForbiddenError'

  constructor(message: string, details: ApiErrorDetails) {
    super('forbidden', message, details)
  }
}

export class ApiNotFoundError extends ApiResponseError {
  override readonly name: string = 'ApiNotFoundError'

  constructor(message: string, details: ApiErrorDetails) {
    super('not-found', message, details)
  }
}

export class ApiConflictError extends ApiResponseError {
  override readonly name: string = 'ApiConflictError'

  constructor(message: string, details: ApiErrorDetails) {
    super('conflict', message, details)
  }
}

export class ApiValidationError extends ApiResponseError {
  override readonly name: string = 'ApiValidationError'

  readonly errors: Readonly<Record<string, string>>

  constructor(message: string, details: ApiErrorDetails) {
    super('validation', message, details)
    this.errors = details.problem?.errors ?? {}
  }
}

export class ApiRateLimitError extends ApiResponseError {
  override readonly name: string = 'ApiRateLimitError'

  readonly retryAfterSeconds: number | undefined

  constructor(message: string, details: ApiErrorDetails) {
    super('rate-limit', message, details)
    this.retryAfterSeconds = details.problem?.retryAfterSeconds
  }
}

export class ApiChannelDeliveryError extends ApiResponseError {
  override readonly name: string = 'ApiChannelDeliveryError'

  constructor(message: string, request: RequestDescriptor, problem: ProblemDetails) {
    super('channel-delivery', message, { status: 502, request, problem })
  }
}

export class ApiUnexpectedResponseError extends ApiResponseError {
  override readonly name: string = 'ApiUnexpectedResponseError'

  constructor(message: string, details: ApiErrorDetails) {
    super('unexpected', message, details)
  }
}
