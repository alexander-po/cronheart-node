import { ApiInvalidRequestError, isCronheartApiError } from './errors.js'
import type { RequestOptions } from './types.js'

export function composed<T>(compose: () => T): T {
  try {
    return compose()
  } catch (error) {
    throw isCronheartApiError(error)
      ? error
      : new ApiInvalidRequestError(
          'This request could not be composed: reading a value it was given threw, so nothing was sent.',
        )
  }
}

export function plainOptions(options: RequestOptions | undefined): RequestOptions {
  return { timeoutMs: options?.timeoutMs, signal: options?.signal }
}
