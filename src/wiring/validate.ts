import { baseUrlRefusal } from '../net/base-url.js'
import { type PingAction, isEmittableAction, segmentFor } from '../ping/action.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, resolveMonitor } from '../ping/resolve.js'
import {
  CronheartConfigurationError,
  InvalidActionError,
  InvalidBaseUrlError,
  InvalidMonitorIdError,
  UnknownMonitorError,
} from './errors.js'

// Every option a client is built from is read off the host's own object, and a getter on
// one of those can throw. What leaves the factory this wraps has to be the type the caller
// was told to catch, whatever the host handed in.
export function sealed<T>(what: string, build: () => T): T {
  try {
    return build()
  } catch (error) {
    throw error instanceof CronheartConfigurationError
      ? error
      : new CronheartConfigurationError(`cronheart: the options passed to ${what} could not be read.`)
  }
}

// A base URL is not merely concatenated onto: a query string or a fragment moves the
// ping path out of the URL entirely, and the request then lands on the site root, which
// answers 200 and classifies as an accepted check-in for as long as nobody looks.
export function assertPingBaseUrl(baseUrl: unknown): asserts baseUrl is string {
  if (typeof baseUrl !== 'string') {
    throw new InvalidBaseUrlError(
      'cronheart: the baseUrl option is not a string. The ping path is appended to it, and a value of another shape is refused rather than coerced into an address nobody chose.',
    )
  }

  const refusal = baseUrlRefusal(baseUrl)

  if (refusal !== undefined) {
    throw new InvalidBaseUrlError(
      `cronheart: ${refusal}. The ping path is appended to it, so a check-in would land somewhere else.`,
    )
  }
}

function notEmittable(action: unknown): InvalidActionError {
  return new InvalidActionError(
    `cronheart: ${JSON.stringify(action)} is not a check-in action this SDK will emit. Use "start", "success" or "fail", or omit it for a heartbeat. The server maps an unrecognised action to a heartbeat, which marks the monitor up.`,
  )
}

export function assertEmittableAction(action: string | null): asserts action is PingAction | null {
  if (action === null || isEmittableAction(action)) {
    return
  }

  throw notEmittable(action)
}

// The last gate before the segment is interpolated into the URL. An unrecognised one does
// not fail on the far side: it matches the route, falls through to the action mapper and
// is recorded as a heartbeat, which marks the monitor up while the job is failing.
export function pingPath(action: PingAction): string {
  const segment = segmentFor(action)

  if (segment === undefined) {
    throw notEmittable(action)
  }

  return segment === null ? '' : `/${segment}`
}

export function defineMonitors(
  into: Record<string, string>,
  monitors: Readonly<Record<string, string>>,
): void {
  for (const [name, id] of Object.entries(monitors)) {
    if (!isMonitorId(id)) {
      throw new InvalidMonitorIdError(
        `cronheart: the id configured for ${JSON.stringify(name)} is not a monitor id. Copy the 36-character identifier from the monitor's page.`,
      )
    }

    into[name] = id
  }
}

export function resolveOrThrow(
  name: string,
  defined: Readonly<Record<string, string>>,
  env: EnvSource,
): string {
  const resolution = resolveMonitor(name, defined, env)

  if (resolution.id !== undefined) {
    return resolution.id
  }

  const monitor = JSON.stringify(resolution.label)

  if (resolution.envVar === undefined) {
    throw new InvalidMonitorIdError(
      `cronheart: the id passed for ${monitor} is not a monitor id. Copy the 36-character identifier from the monitor's page.`,
    )
  }

  if (resolution.reason === 'malformed') {
    throw new InvalidMonitorIdError(
      `cronheart: the value ${resolution.envVar} holds is not a monitor id, so ${monitor} cannot be monitored.`,
    )
  }

  throw new UnknownMonitorError(
    `cronheart: no monitor id for ${monitor}. Set ${resolution.envVar}, or pass monitors: { ${monitor}: '<id>' } to createPingClient.`,
  )
}
