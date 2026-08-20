import { PING_ROUTE_UUID_PATTERN } from '../constants.js'
import type { EnvSource } from './env.js'

const ROUTE_SHAPE = new RegExp(PING_ROUTE_UUID_PATTERN)

const CANONICAL_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OPENS_LIKE_AN_ID = /^[0-9a-fA-F]{8}-/

export type ResolutionReason = 'ok' | 'unset' | 'malformed'

export interface Resolution {
  readonly id: string | undefined
  readonly reason: ResolutionReason
  readonly envVar: string
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

export function resolveMonitor(
  name: string,
  defined: Readonly<Record<string, string>>,
  env: EnvSource,
): Resolution {
  const envVar = envVarFor(name)
  const label = labelFor(name)
  const settle = (candidate: string | undefined): Resolution => {
    if (candidate === undefined) {
      return { id: undefined, reason: 'unset', envVar, label }
    }

    return isMonitorId(candidate)
      ? { id: candidate, reason: 'ok', envVar, label }
      : { id: undefined, reason: 'malformed', envVar, label }
  }

  if (opensLikeAnId(name)) {
    return settle(name)
  }

  const explicit = defined[name]

  if (explicit !== undefined) {
    return settle(explicit)
  }

  const key = screaming(name)
  const fromEnv = (env[`CRONHEART_${key}_UUID`] ?? env[`CRON_MONITOR_${key}_UUID`] ?? '').trim()

  return settle(fromEnv === '' ? undefined : fromEnv)
}
