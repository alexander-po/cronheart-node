import { API_IDEMPOTENCY_TTL_SECONDS } from './constants.js'
import {
  ApiAuthenticationError,
  ApiChannelDeliveryError,
  ApiConflictError,
  ApiForbiddenError,
  ApiNotFoundError,
  ApiPlanRestrictionError,
  ApiRateLimitError,
  ApiUnexpectedResponseError,
  ApiValidationError,
  type AnyCronheartApiError,
  type RequestDescriptor,
} from './errors.js'
import { PAID_ONLY_NOTICE } from './tier.js'
import type { ProblemDetails, RateLimitSnapshot } from './types.js'

// Kept apart from the descriptor a caller sees on the error: which route this was is a
// routing decision of this client's, not part of describing the request.
export interface ResponseContext {
  readonly request: RequestDescriptor
  readonly rateLimit?: RateLimitSnapshot | undefined
  readonly deliversDownstream?: boolean | undefined
  readonly separatelyThrottled?: boolean | undefined
}

function where(request: RequestDescriptor): string {
  return `${request.method} ${request.path}`
}

function listed(errors: Readonly<Record<string, string>> | undefined): string {
  const fields = errors === undefined ? [] : Object.keys(errors)

  return fields.length === 0 ? '' : `: ${fields.join(', ')}`
}

function retryGuidance(seconds: number | undefined): string {
  return seconds === undefined
    ? 'The response carried no retry guidance.'
    : `Retry after ${seconds} s.`
}

// Every sentence below is written here rather than read off the response. The service
// publishes no machine-readable code, its 401 detail is a translation key, and three
// unrelated conditions share the 409 — so status is the only thing safe to branch on and
// the only thing a reader can be told without being misled.
export function errorForStatus(
  status: number,
  problem: ProblemDetails,
  context: ResponseContext,
): AnyCronheartApiError {
  const { request, rateLimit } = context
  const details = { status, problem, request, rateLimit }
  const at = where(request)

  if (status === 401) {
    return new ApiAuthenticationError(
      `The API rejected this key (HTTP 401) on ${at}. A key is shown once when it is created and cannot be read back, so check the value CRONHEART_API_KEY holds rather than re-reading it from the account.`,
      details,
    )
  }

  if (status === 402) {
    return new ApiPlanRestrictionError(`${at} was refused. ${PAID_ONLY_NOTICE}`, details)
  }

  if (status === 403) {
    return new ApiForbiddenError(
      `The account may not do this (HTTP 403) on ${at}. The monitor limit may be reached, or the account's email address may still be unverified.`,
      details,
    )
  }

  if (status === 404) {
    return new ApiNotFoundError(
      `No such resource (HTTP 404) on ${at}. A resource outside this key's project is reported the same way, so a key scoped to another project looks identical to a deleted one.`,
      details,
    )
  }

  if (status === 409) {
    return new ApiConflictError(
      `The request conflicted with the account's current state (HTTP 409) on ${at}. An idempotency key is reserved for ${API_IDEMPOTENCY_TTL_SECONDS} s and is refused while the first request is still running, reused with a different body, or aimed at a channel kind the service has switched off — read the resource back before deciding it was not created.`,
      details,
    )
  }

  if (status === 422) {
    return new ApiValidationError(
      `The service rejected the request as invalid (HTTP 422) on ${at}${listed(problem.errors)}.`,
      details,
    )
  }

  if (status === 429) {
    // Two routes carry throttles of their own and answer with the account's rate-limit
    // headers regardless, so on those the reading beside a refusal still reads healthy.
    return new ApiRateLimitError(
      context.separatelyThrottled === true
        ? `This request was refused as too frequent (HTTP 429) on ${at}. ${retryGuidance(problem.retryAfterSeconds)} This route carries a throttle of its own, so the rate-limit reading beside this describes the account's API limit and not the allowance that refused it.`
        : `The account's API rate limit is exhausted (HTTP 429) on ${at}. ${retryGuidance(problem.retryAfterSeconds)} The limit is per account and shared by every key it holds.`,
      details,
    )
  }

  if (status === 502 && context.deliversDownstream === true) {
    return new ApiChannelDeliveryError(
      `The channel's own destination refused the test delivery (HTTP 502) on ${at}. This is the destination failing, not the API.`,
      details,
    )
  }

  return new ApiUnexpectedResponseError(
    `The service answered ${at} with HTTP ${status}, which this client does not know how to read.`,
    details,
  )
}
