import { cronDialectRefusal, readsAsAnHourOfTheDay } from '../cron-dialect.js'
import { labelFor } from '../ping/resolve.js'
import { InvalidScheduleError, InvalidTimezoneError, UnknownMonitorError } from './errors.js'

// An expression the scheduler takes and the service refuses means the monitor's schedule is
// not the job's, and nothing on the wire would ever say so — the check-ins keep arriving, at
// times the monitor does not expect.
export function assertServiceCron(expression: unknown, monitor: string, dialect: string): void {
  if (typeof expression !== 'string') {
    throw new InvalidScheduleError(
      `cronheart: the schedule given for ${JSON.stringify(labelFor(monitor))} is not a string, so it cannot be checked against the expression the service will hold.`,
    )
  }

  const refusal = cronDialectRefusal(expression, dialect)

  if (refusal !== undefined) {
    throw new InvalidScheduleError(`cronheart: ${refusal}`)
  }
}

export function assertTimezone(zone: unknown, monitor: string): asserts zone is string {
  const named = typeof zone === 'string' ? zone : undefined

  if (named !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: named })

      return
    } catch {}
  }

  throw new InvalidTimezoneError(
    `cronheart: ${JSON.stringify(String(zone))} is not a time zone this runtime knows, so ${JSON.stringify(labelFor(monitor))} would fire at an hour nobody chose. Name one from the IANA database, such as "Europe/Berlin".`,
  )
}

// A scheduler given no zone reads the expression in the host's local zone — commonly UTC in
// a container, while the monitor was created in the operator's own. The alert then lands an
// offset away, and reads as the service being wrong rather than the two disagreeing.
export function zoneUnstatedAdvice(
  expression: string,
  monitor: string,
  option: string,
): string | undefined {
  if (!readsAsAnHourOfTheDay(expression)) {
    return undefined
  }

  const local = localZone()

  return `cronheart: ${JSON.stringify(labelFor(monitor))} is scheduled at an hour of the day and no zone was named, so it will fire in ${local}. Set ${option} to the zone the monitor was created in, or the alert lands at the wrong hour.`
}

function localZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'the host zone'
  } catch {
    return 'the host zone'
  }
}

export function assertMonitorNamed(name: unknown, from: string): asserts name is string {
  if (typeof name === 'string' && name.trim() !== '') {
    return
  }

  throw new UnknownMonitorError(
    `cronheart: no monitor name was given and ${from} carries none, so there is nothing to check in for. Pass the name the monitor was created under.`,
  )
}
