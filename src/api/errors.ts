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

// The coarser of the two discriminants: "the server refused this" is one class, reachable
// without an instanceof against the base of that family.
export type ApiErrorGroup =
  | 'configuration'
  | 'invalid-request'
  | 'transport'
  | 'hydration'
  | 'response'

export type ApiResponseKind = Exclude<
  ApiErrorKind,
  'configuration' | 'invalid-request' | 'transport' | 'hydration'
>

function groupFor(kind: ApiErrorKind): ApiErrorGroup {
  if (
    kind === 'configuration' ||
    kind === 'invalid-request' ||
    kind === 'transport' ||
    kind === 'hydration'
  ) {
    return kind
  }

  return 'response'
}

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

  readonly group: ApiErrorGroup

  readonly status: number | undefined

  readonly problem: ProblemDetails | undefined

  readonly request: RequestDescriptor | undefined

  readonly rateLimit: RateLimitSnapshot | undefined

  constructor(kind: ApiErrorKind, message: string, details: ApiErrorDetails = {}) {
    super(message, 'cause' in details ? { cause: details.cause } : undefined)
    this.kind = kind
    this.group = groupFor(kind)
    this.status = details.status
    this.problem = details.problem
    this.request = details.request
    this.rateLimit = details.rateLimit
    Object.defineProperty(this, BRAND, { value: true, enumerable: false })
  }

  static isCronheartApiError(value: unknown): value is AnyCronheartApiError {
    return isCronheartApiError(value)
  }
}

export function isCronheartApiError(value: unknown): value is AnyCronheartApiError {
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

  declare readonly kind: 'configuration'

  declare readonly group: 'configuration'

  constructor(message: string) {
    super('configuration', message)
  }
}

export class ApiInvalidRequestError extends CronheartApiError {
  override readonly name: string = 'ApiInvalidRequestError'

  declare readonly kind: 'invalid-request'

  declare readonly group: 'invalid-request'

  constructor(message: string) {
    super('invalid-request', message)
  }
}

export class ApiTransportError extends CronheartApiError {
  override readonly name: string = 'ApiTransportError'

  declare readonly kind: 'transport'

  declare readonly group: 'transport'

  readonly reason: ApiTransportReason

  constructor(reason: ApiTransportReason, message: string, details: ApiErrorDetails = {}) {
    super('transport', message, details)
    this.reason = reason
  }
}

export class ApiHydrationError extends CronheartApiError {
  override readonly name: string = 'ApiHydrationError'

  declare readonly kind: 'hydration'

  declare readonly group: 'hydration'

  constructor(message: string, details: ApiErrorDetails = {}) {
    super('hydration', message, details)
  }
}

export class ApiResponseError extends CronheartApiError {
  override readonly name: string = 'ApiResponseError'

  declare readonly kind: ApiResponseKind

  declare readonly group: 'response'
}

export class ApiAuthenticationError extends ApiResponseError {
  override readonly name: string = 'ApiAuthenticationError'

  declare readonly kind: 'authentication'

  constructor(message: string, details: ApiErrorDetails) {
    super('authentication', message, details)
  }
}

export class ApiPlanRestrictionError extends ApiResponseError {
  override readonly name: string = 'ApiPlanRestrictionError'

  declare readonly kind: 'plan-restriction'

  readonly upgradeUrl: string | undefined

  constructor(message: string, details: ApiErrorDetails) {
    super('plan-restriction', message, details)
    this.upgradeUrl = details.problem?.upgradeUrl
  }
}

export class ApiForbiddenError extends ApiResponseError {
  override readonly name: string = 'ApiForbiddenError'

  declare readonly kind: 'forbidden'

  constructor(message: string, details: ApiErrorDetails) {
    super('forbidden', message, details)
  }
}

export class ApiNotFoundError extends ApiResponseError {
  override readonly name: string = 'ApiNotFoundError'

  declare readonly kind: 'not-found'

  constructor(message: string, details: ApiErrorDetails) {
    super('not-found', message, details)
  }
}

export class ApiConflictError extends ApiResponseError {
  override readonly name: string = 'ApiConflictError'

  declare readonly kind: 'conflict'

  constructor(message: string, details: ApiErrorDetails) {
    super('conflict', message, details)
  }
}

export class ApiValidationError extends ApiResponseError {
  override readonly name: string = 'ApiValidationError'

  declare readonly kind: 'validation'

  readonly errors: Readonly<Record<string, string>>

  constructor(message: string, details: ApiErrorDetails) {
    super('validation', message, details)
    this.errors = details.problem?.errors ?? {}
  }
}

export class ApiRateLimitError extends ApiResponseError {
  override readonly name: string = 'ApiRateLimitError'

  declare readonly kind: 'rate-limit'

  readonly retryAfterSeconds: number | undefined

  constructor(message: string, details: ApiErrorDetails) {
    super('rate-limit', message, details)
    this.retryAfterSeconds = details.problem?.retryAfterSeconds
  }
}

export class ApiChannelDeliveryError extends ApiResponseError {
  override readonly name: string = 'ApiChannelDeliveryError'

  declare readonly kind: 'channel-delivery'

  constructor(message: string, details: ApiErrorDetails) {
    super('channel-delivery', message, { ...details, status: 502 })
  }
}

export class ApiUnexpectedResponseError extends ApiResponseError {
  override readonly name: string = 'ApiUnexpectedResponseError'

  declare readonly kind: 'unexpected'

  constructor(message: string, details: ApiErrorDetails) {
    super('unexpected', message, details)
  }
}

// What the brand check narrows to. Each member declares its own discriminant, so the check
// the README documents — read error.kind, then read the field that kind carries — compiles.
export type AnyCronheartApiError =
  | ApiAuthenticationError
  | ApiChannelDeliveryError
  | ApiConfigurationError
  | ApiConflictError
  | ApiForbiddenError
  | ApiHydrationError
  | ApiInvalidRequestError
  | ApiNotFoundError
  | ApiPlanRestrictionError
  | ApiRateLimitError
  | ApiTransportError
  | ApiUnexpectedResponseError
  | ApiValidationError
