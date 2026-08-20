import { PING_ROUTE_UUID_PATTERN } from '../constants.js'
import type { EnvSource } from './env.js'

const ROUTE_SHAPE = new RegExp(PING_ROUTE_UUID_PATTERN)

const CANONICAL_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OPENS_LIKE_AN_ID = /^[0-9a-fA-F]{8}-/

export type ResolutionReason = 'ok' | 'unset' | 'malformed'

export interface Resolution {
  readonly id: string | undefined
  readonly reason: ResolutionReason
  // Undefined when the caller passed an id rather than a name: there is no variable to
  // name, and naming one would print a screamed copy of the id the route is secured by.
  readonly envVar: string | undefined
  readonly label: string
}

export function isMonitorId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_SHAPE.test(value) && ROUTE_SHAPE.test(value)
}

export function opensLikeAnId(value: string): boolean {
  return OPENS_LIKE_AN_ID.test(value)
}

function screaming(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function envVarFor(name: string): string {
  return `CRONHEART_${screaming(name)}_UUID`
}

export function labelFor(name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    return '<no monitor>'
  }

  return opensLikeAnId(name) ? `id…${name.slice(-4)}` : name
}

function definedFor(
  defined: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.hasOwn(defined, name) ? defined[name] : undefined
}

function configuredIn(env: EnvSource, name: string): string | undefined {
  const key = screaming(name)
  const value = (env[`CRONHEART_${key}_UUID`] ?? env[`CRON_MONITOR_${key}_UUID`] ?? '').trim()

  return value === '' ? undefined : value
}

function settle(
  candidate: string | undefined,
  named: { readonly envVar: string | undefined; readonly label: string },
): Resolution {
  if (candidate === undefined) {
    return { id: undefined, reason: 'unset', ...named }
  }

  return isMonitorId(candidate)
    ? { id: candidate, reason: 'ok', ...named }
    : { id: undefined, reason: 'malformed', ...named }
}

// Only a full id is read as an id, and a name that resolved through the map or the
// environment is a name whatever its own first group looks like. Reading the shape first
// lets a name shadow the configuration written for it, and prints its tail as an id.
export function resolveMonitor(
  name: string,
  defined: Readonly<Record<string, string>>,
  env: EnvSource,
): Resolution {
  if (isMonitorId(name)) {
    return { id: name, reason: 'ok', envVar: undefined, label: labelFor(name) }
  }

  const idShaped = opensLikeAnId(name)
  const envVar = idShaped ? undefined : envVarFor(name)
  const configured = definedFor(defined, name) ?? configuredIn(env, name)

  if (configured !== undefined) {
    return settle(configured, { envVar, label: name })
  }

  return settle(idShaped ? name : undefined, { envVar, label: labelFor(name) })
}
