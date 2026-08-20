import { type PingAction, isEmittableAction, segmentFor } from '../ping/action.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, resolveMonitor } from '../ping/resolve.js'
import {
  InvalidActionError,
  InvalidBaseUrlError,
  InvalidMonitorIdError,
  UnknownMonitorError,
} from './errors.js'

// A base URL is not merely concatenated onto: a query string or a fragment moves the
// ping path out of the URL entirely, and the request then lands on the site root, which
// answers 200 and classifies as an accepted check-in for as long as nobody looks.
export function assertPingBaseUrl(baseUrl: string): void {
  const refuse = (why: string): never => {
    throw new InvalidBaseUrlError(
      `cronheart: ${JSON.stringify(baseUrl)} cannot be a base URL — ${why}. The ping path is appended to it, so a check-in would land somewhere else and be recorded as accepted.`,
    )
  }
  let parsed: URL

  try {
    parsed = new URL(baseUrl)
  } catch {
    return refuse('it is not a URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    refuse('it is not http or https')
  }

  if (parsed.search !== '' || parsed.hash !== '') {
    refuse('it carries a query string or a fragment')
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
