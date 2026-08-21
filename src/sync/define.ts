import { isCronheartApiError } from '../api/errors.js'
import {
  assertGraceSeconds,
  assertMonitorName,
  assertScheduleExpression,
  canonicalTimezone,
} from '../api/validate.js'
import { envVarFor } from '../ping/resolve.js'
import { refuse } from './errors.js'
import { routingFrom } from './routing.js'
import { normaliseSchedule } from './schedule.js'
import type {
  DefinedMonitor,
  MonitorConfig,
  MonitorDefinition,
  SyncConfigInput,
} from './types.js'

const CONFIG_BRAND = Symbol.for('cronheart.sync.config')

// The bounds the service holds are checked by the management client, which is the one place
// they live. Its refusals name a request field; here they have to name the monitor as well.
function checked<T>(monitor: string, check: () => T): T {
  try {
    return check()
  } catch (error) {
    if (isCronheartApiError(error) && error.kind === 'invalid-request') {
      refuse(error.message, monitor)
    }

    throw error
  }
}

function definitionsIn(input: SyncConfigInput): readonly MonitorDefinition[] {
  if (Array.isArray(input)) {
    return input as readonly MonitorDefinition[]
  }

  const monitors = (input as { monitors?: unknown } | null | undefined)?.monitors

  if (!Array.isArray(monitors)) {
    refuse(
      'A configuration is a list of monitors, or an object carrying one under "monitors". Reconciling against something of another shape would read as an account with nothing in it.',
    )
  }

  return monitors as readonly MonitorDefinition[]
}

function defined(definition: MonitorDefinition): DefinedMonitor {
  if (typeof definition !== 'object' || definition === null) {
    refuse('A monitor is an object carrying at least a name and a schedule.')
  }

  const name = definition.name

  checked(String(name), () => {
    assertMonitorName(name)
  })

  const schedule = normaliseSchedule(definition.schedule, name)

  checked(name, () => {
    assertScheduleExpression(schedule.kind, schedule.expr)
  })


  if (definition.graceSeconds !== undefined) {
    checked(name, () => {
      assertGraceSeconds(definition.graceSeconds)
    })
  }

  return {
    name,
    scheduleKind: schedule.kind,
    scheduleExpr: schedule.expr,
    tz:
      definition.tz === undefined
        ? undefined
        : checked(name, () => canonicalTimezone(definition.tz)),
    graceSeconds: definition.graceSeconds,
    routing: routingFrom(definition.channels, name),
  }
}

// A name is the whole of sync's identity for a monitor, and the service enforces no
// uniqueness on one. Two rows carrying a name is a conflict nothing can resolve, so a
// configuration that would produce one is refused here — before a credential is read, before
// a request exists, and without a network to be reachable.
function refuseRepeats(monitors: readonly DefinedMonitor[]): void {
  const byName = new Map<string, number>()
  const byVariable = new Map<string, string[]>()

  for (const monitor of monitors) {
    byName.set(monitor.name, (byName.get(monitor.name) ?? 0) + 1)
    const variable = envVarFor(monitor.name)
    byVariable.set(variable, [...(byVariable.get(variable) ?? []), monitor.name])
  }

  for (const [name, count] of byName) {
    if (count > 1) {
      refuse(
        `This configuration defines ${count} monitors named ${JSON.stringify(name)}. A name is how sync tells one monitor from another and the service enforces no uniqueness on one, so there would be no way to say which row each of them meant.`,
      )
    }
  }

  for (const [variable, names] of byVariable) {
    if (names.length > 1) {
      refuse(
        `${names.map((name) => JSON.stringify(name)).join(' and ')} both resolve to ${variable}, so only one of them could ever be addressed by name.`,
      )
    }
  }
}

export function defineMonitors(input: SyncConfigInput): MonitorConfig {
  if (isDefinedConfig(input)) {
    return input
  }

  const monitors = definitionsIn(input).map(defined)

  refuseRepeats(monitors)

  const config: MonitorConfig = { monitors }

  Object.defineProperty(config, CONFIG_BRAND, { value: true, enumerable: false })

  return config
}

export function isDefinedConfig(value: unknown): value is MonitorConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  try {
    return (value as Record<symbol, unknown>)[CONFIG_BRAND] === true
  } catch {
    return false
  }
}
