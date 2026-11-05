import { UUID_WHOLE } from '../identifier-shape.js'
import { withForbiddenSpelledOut, withLabelControlsRemoved, withLabelControlsSpelledOut } from '../print-set.js'
import type { EnvSource } from './env.js'

const OPENS_LIKE_AN_ID = /^[0-9a-fA-F]{8}-/

const GROUPED_LIKE_AN_ID = /^[^-]{8}-[^-]{4}-[^-]{4}-[^-]{4}-[^-]{12}$/

const HEX_AND_DASHES = /^[0-9a-f-]{30,40}$/i

export type ResolutionReason = 'ok' | 'unset' | 'malformed'

export interface Resolution {
  readonly id: string | undefined
  readonly reason: ResolutionReason
  // Undefined when the caller passed an id rather than a name: there is no variable to
  // name, and naming one would print a screamed copy of the id the route is secured by.
  readonly envVar: string | undefined
  readonly label: string
  // What a once-per-monitor warning is keyed on. Never printed, because it is the name as given.
  readonly key: string
}

export function isMonitorId(value: unknown): value is string {
  return typeof value === 'string' && UUID_WHOLE.test(value)
}

// Shaped like an identifier the whole way through, one edit from a real one. Nobody names
// a monitor this, which is what makes it safe to read as a broken id rather than a name.
function hasIdShape(value: string): boolean {
  const read = withLabelControlsRemoved(value)

  return GROUPED_LIKE_AN_ID.test(read) || HEX_AND_DASHES.test(read)
}

// Weaker: a name may legitimately open with eight hexadecimal digits and a dash, so this
// decides how a value is printed back, never whether it is a name.
export function looksLikeAnId(value: string): boolean {
  return OPENS_LIKE_AN_ID.test(withLabelControlsRemoved(value)) || hasIdShape(value)
}

function screaming(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

// A monitor id is the whole check-in capability, so text that carries one is never printed:
// a label, a hint or an echo holding one is shown as the id's last four digits and nothing else.
// It is held when an id is grouped as one, whatever separates the groups, or when a run of
// hexadecimal digits that only characters other than letters and digits join holds an id's
// worth of them and a letter among them. A letter or a digit of any other kind ends a run, and
// a run of decimal digits alone is a date, an address or a number, never an id, unless it is an
// id's length unbroken. A screamed variable joins every word, so it is held to the strict half.
const ID_ANY_SEPARATOR = /[0-9a-f]{8}(?:[^0-9a-z]+[0-9a-f]{4}){3}[^0-9a-z]+[0-9a-f]{12}/i

const BETWEEN_DIGITS = /[^\p{L}\p{N}]|\p{Default_Ignorable_Code_Point}/gu

const COMPACT_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

function strictlyHeldIn(text: string): string | undefined {
  return text.match(ID_ANY_SEPARATOR)?.[0] ?? text.replace(IGNORABLE, '').match(COMPACT_ID)?.[0]
}

function idHeldIn(text: string): string | undefined {
  return (
    strictlyHeldIn(text) ??
    text
      .replace(BETWEEN_DIGITS, '')
      .split(/[^0-9a-f]+/i)
      .findLast((run) => run.length > 31 && /[a-f]/i.test(run))
  )
}

export function idMark(text: string): string | undefined {
  const held = idHeldIn(text)

  return held === undefined ? undefined : `id…${held.slice(-4)}`
}

export function holdsAnId(text: string): boolean {
  return idHeldIn(text) !== undefined
}

export function printable(text: string): string {
  return idMark(text) ?? withForbiddenSpelledOut(text)
}

// A name is read once more through the variable it screams into, so the label, the hint and
// init's refusal never disagree about whether it holds an id.
function nameMark(name: string): string | undefined {
  const variable = strictlyHeldIn(envVarFor(name))

  return idMark(name) ?? (variable === undefined ? undefined : `id…${variable.slice(-4).toLowerCase()}`)
}

export function nameHoldsAnId(name: string): boolean {
  return nameMark(name) !== undefined
}

export function shown(name: string): string {
  return nameMark(name) ?? withLabelControlsSpelledOut(name)
}

export function envVarFor(name: string): string {
  return `CRONHEART_${screaming(name)}_UUID`
}

export function labelFor(name: unknown): string {
  if (typeof name !== 'string' || name === '') {
    return '<no monitor>'
  }

  return looksLikeAnId(name) ? `id…${[...name.replace(BETWEEN_DIGITS, '')].slice(-4).join('')}` : shown(name)
}

// The variable a diagnostic tells the reader to set. Looking a name up still screams the whole
// of it, so a name or a variable that holds an id is named by a placeholder instead.
export function shownVariableFor(name: string): string {
  return nameHoldsAnId(name) ? 'CRONHEART_<NAME>_UUID' : envVarFor(name)
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
  named: { readonly envVar: string | undefined; readonly label: string; readonly key: string },
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
    return { id: name, reason: 'ok', envVar: undefined, label: labelFor(name), key: name }
  }

  const idShaped = looksLikeAnId(name)
  const envVar = idShaped ? undefined : shownVariableFor(name)
  const configured =
    definedFor(defined, name) ?? (hasIdShape(name) ? undefined : configuredIn(env, name))

  if (configured !== undefined) {
    return settle(configured, { envVar, label: shown(name), key: name })
  }

  return settle(idShaped ? name : undefined, { envVar, label: labelFor(name), key: name })
}
