import type { EnvSource } from './env.js'

const CANONICAL_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const OPENS_LIKE_AN_ID = /^[0-9a-fA-F]{8}-/

const GROUPED_LIKE_AN_ID = /^[^-]{8}-[^-]{4}-[^-]{4}-[^-]{4}-[^-]{12}$/

const HEX_AND_DASHES = /^[0-9a-fA-F-]{30,40}$/

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
  return typeof value === 'string' && CANONICAL_SHAPE.test(value)
}

// Shaped like an identifier the whole way through, one edit from a real one. Nobody names
// a monitor this, which is what makes it safe to read as a broken id rather than a name.
function hasIdShape(value: string): boolean {
  return GROUPED_LIKE_AN_ID.test(value) || HEX_AND_DASHES.test(value)
}

// Weaker: a name may legitimately open with eight hexadecimal digits and a dash, so this
// decides how a value is printed back, never whether it is a name.
export function looksLikeAnId(value: string): boolean {
  return OPENS_LIKE_AN_ID.test(value) || hasIdShape(value)
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

  return looksLikeAnId(name) ? `id…${name.slice(-4)}` : name
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
// environment is a name whatever its own first group looks like. Nothing wholly id-shaped
// is looked up: screaming a mistyped id into a variable name searches the environment.
export function resolveMonitor(
  name: string,
  defined: Readonly<Record<string, string>>,
  env: EnvSource,
): Resolution {
  if (isMonitorId(name)) {
    return { id: name, reason: 'ok', envVar: undefined, label: labelFor(name) }
  }

  const idShaped = looksLikeAnId(name)
  const envVar = idShaped ? undefined : envVarFor(name)
  const configured =
    definedFor(defined, name) ?? (hasIdShape(name) ? undefined : configuredIn(env, name))

  if (configured !== undefined) {
    return settle(configured, { envVar, label: name })
  }

  return settle(idShaped ? name : undefined, { envVar, label: labelFor(name) })
}
