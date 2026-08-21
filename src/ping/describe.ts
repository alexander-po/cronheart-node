import type { Resolution } from './resolve.js'
import type { PingResult } from './types.js'

type Reported = Omit<PingResult, 'message'>

export function outcomeLine(result: Reported): string {
  const status = result.status === undefined ? '' : ` (HTTP ${result.status})`

  return `${result.action} check-in for ${JSON.stringify(result.monitor)} ${result.outcome}${status}`
}

// Total over the outcome vocabulary, so a consumer replacing the built-in warner with a
// result callback has every sentence the warner had.
export function describePingResult(result: PingResult): string {
  return result.message ?? `${outcomeLine(result)}.`
}

// A message is what the built-in warner speaks. A cancellation the caller asked for and a
// check-in the server recorded are messageless on purpose: described on demand, never announced.
export function messageFor(result: Reported, resolution: Resolution): string | undefined {
  const monitor = JSON.stringify(result.monitor)
  const envVar = resolution.envVar
  const outcome = result.outcome

  if (outcome === 'disabled') {
    return `CRONHEART_DISABLED is set, so no check-in was sent for ${monitor}. Unset it to resume monitoring.`
  }

  if (outcome === 'suppressed') {
    if (envVar === undefined || resolution.reason === 'malformed') {
      const source = envVar === undefined ? 'the id passed for it' : `the value ${envVar} holds`

      return `${source} is not a monitor id, so nothing was sent for ${monitor}.`
    }

    return `no monitor id for ${monitor}, so nothing was sent. Set ${envVar}, or pass monitors: { … } to createPingClient.`
  }

  if (outcome === 'not-found') {
    const where = envVar === undefined ? 'the id it was given' : envVar

    return `the server does not recognise the monitor for ${monitor} (HTTP 404). Check ${where}.`
  }

  if (outcome === 'paused') {
    return `the monitor for ${monitor} is paused (HTTP 410). Check-ins are recorded, but no alert will fire.`
  }

  if (outcome === 'rate-limited') {
    return `the server is rate limiting check-ins for ${monitor} (HTTP 429), so this one was not recorded.`
  }

  if (outcome === 'server-error') {
    return `the server could not record the check-in for ${monitor} (HTTP ${String(result.status)}), and the retries did not settle it.`
  }

  if (outcome === 'timeout') {
    return `the check-in for ${monitor} ran out of its time budget. Raise CRONHEART_TIMEOUT_MS if this is normal for the network.`
  }

  if (outcome === 'network-error') {
    return `the check-in for ${monitor} could not reach the server. The job is unaffected, but the monitor is heading for late.`
  }

  if (outcome === 'unexpected') {
    return `the check-in for ${monitor} failed for a reason this SDK does not recognise.`
  }

  return undefined
}
