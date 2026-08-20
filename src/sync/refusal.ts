import { isCronheartApiError } from '../api/errors.js'
import { PAID_ONLY_NOTICE } from '../api/tier.js'

const CONCURRENT_RUN =
  'the service is holding a reservation for this exact create, which is another run of this configuration finishing it. Nothing was made twice; read the plan again once that run is done'

// Hard-coded per class, never the service's own detail string: on one status that string is a
// translation key and on another it is product prose, and neither is a sentence for a reader.
export function describeApiRefusal(error: unknown, what: string): string {
  if (!isCronheartApiError(error)) {
    return error instanceof Error ? error.message : String(error)
  }

  if (error.kind === 'plan-restriction') {
    return `${what} needs the REST API. ${PAID_ONLY_NOTICE}`
  }

  if (error.kind === 'authentication') {
    return 'the API key this run authenticated with was refused. Check CRONHEART_API_KEY against the key on the account’s API tokens page.'
  }

  if (error.kind === 'rate-limit') {
    return 'the account’s API rate limit is spent. Every token an account holds shares one limit; wait for the window to pass and run again.'
  }

  if (error.kind === 'validation') {
    const fields = Object.keys(error.errors)

    return fields.length === 0
      ? 'the service refused this request.'
      : `the service refused this request over ${fields.join(', ')}.`
  }

  if (error.kind === 'conflict') {
    return CONCURRENT_RUN
  }

  return error.message
}

// Refusals that will refuse every remaining request the same way. Carrying on past one turns
// a single cause into one failure per monitor and hides which of them was the cause.
export function refusesEverything(error: unknown): boolean {
  return (
    isCronheartApiError(error) &&
    (error.kind === 'authentication' ||
      error.kind === 'plan-restriction' ||
      error.kind === 'rate-limit')
  )
}
