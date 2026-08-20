import type { PingAction } from '../ping/action.js'
import type { EnvSource } from '../ping/env.js'
import { isMonitorId, resolveMonitor } from '../ping/resolve.js'
import { InvalidActionError, InvalidMonitorIdError, UnknownMonitorError } from './errors.js'

export function assertEmittableAction(action: string | null): asserts action is PingAction | null {
  if (action === null || action === 'start' || action === 'success' || action === 'fail') {
    return
  }

  throw new InvalidActionError(
    `cronheart: ${JSON.stringify(action)} is not a check-in action this SDK will emit. Use "start", "success" or "fail", or omit it for a heartbeat. The server maps an unrecognised action to a heartbeat, which marks the monitor up.`,
  )
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

  if (resolution.reason === 'malformed') {
    throw new InvalidMonitorIdError(
      `cronheart: the value ${resolution.envVar} holds is not a monitor id, so ${JSON.stringify(name)} cannot be monitored.`,
    )
  }

  throw new UnknownMonitorError(
    `cronheart: no monitor id for ${JSON.stringify(name)}. Set ${resolution.envVar}, or pass monitors: { ${JSON.stringify(name)}: '<id>' } to createPingClient.`,
  )
}
