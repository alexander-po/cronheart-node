import {
  CRON_ALIASES,
  CRON_FIELD_COUNT,
  INTERVAL_SECONDS_MAX,
  INTERVAL_SECONDS_MIN,
  SIMPLE_SCHEDULES,
} from '../api/constants.js'
import type { ScheduleKind } from '../api/types.js'
import { refuse } from './errors.js'

export interface NormalisedSchedule {
  readonly kind: ScheduleKind
  readonly expr: string
}

const EVERY = /^([0-9]+)(s|m|h|d)?$/

const EVERY_SCALE: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3600, d: 86400 }

const CRON_FIELDS = 'minute, hour, day of month, month, day of week'

function isAlias(expression: string): boolean {
  return (CRON_ALIASES as readonly string[]).includes(expression.toLowerCase())
}

function isSimple(expression: string): boolean {
  return (SIMPLE_SCHEDULES as readonly string[]).includes(expression)
}

// The expression is sent exactly as it was written, aliases and spacing included: the
// service stores what it is given and returns it unchanged, so anything normalised here
// would read back as a difference on the next run.
function asCron(expression: string, monitor: string): NormalisedSchedule {
  if (isAlias(expression)) {
    return { kind: 'cron', expr: expression }
  }

  if (expression.startsWith('@')) {
    refuse(
      `${JSON.stringify(expression)} is not a schedule alias this service knows. The seven it accepts are ${CRON_ALIASES.join(', ')}; @reboot is not among them, because nothing here ever sees your machine start.`,
      monitor,
    )
  }

  const fields = expression.split(/\s+/).filter((field) => field !== '')

  if (fields.length === CRON_FIELD_COUNT) {
    return { kind: 'cron', expr: expression }
  }

  const opening = `A cron expression here has five fields — ${CRON_FIELDS} — and this one has ${fields.length}.`

  refuse(
    fields.length > CRON_FIELD_COUNT
      ? `${opening} croner and node-cron accept a sixth leading seconds field; this service does not, so drop it and write the schedule in minutes.`
      : opening,
    monitor,
  )
}

function secondsFrom(value: string | number, monitor: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      refuse(
        `An interval is a whole number of seconds, and ${String(value)} is not one.`,
        monitor,
      )
    }

    return value
  }

  const match = EVERY.exec(String(value).trim())

  if (match === null) {
    refuse(
      `${JSON.stringify(String(value))} is not an interval. Write it as a whole number of seconds, or with a unit: 90s, 5m, 2h, 1d.`,
      monitor,
    )
  }

  return Number(match[1]) * (EVERY_SCALE[match[2] ?? 's'] ?? 1)
}

// The service wants whole seconds written as a decimal string, bounded at both ends. Nobody
// should have to discover that from a 422, so every interval form lands here.
function asInterval(value: string | number, monitor: string): NormalisedSchedule {
  const seconds = secondsFrom(value, monitor)

  if (seconds < INTERVAL_SECONDS_MIN || seconds > INTERVAL_SECONDS_MAX) {
    refuse(
      `An interval must be between ${INTERVAL_SECONDS_MIN} and ${INTERVAL_SECONDS_MAX} seconds, and this one is ${seconds}.`,
      monitor,
    )
  }

  return { kind: 'interval', expr: String(seconds) }
}

function asSimple(value: unknown, monitor: string): NormalisedSchedule {
  if (typeof value !== 'string' || !isSimple(value)) {
    refuse(
      `${JSON.stringify(String(value))} is not one of the twelve schedules this service names: ${SIMPLE_SCHEDULES.join(', ')}.`,
      monitor,
    )
  }

  return { kind: 'simple', expr: value }
}

function fromText(text: string, monitor: string): NormalisedSchedule {
  const expression = text.trim()

  if (isSimple(expression)) {
    return { kind: 'simple', expr: expression }
  }

  if (expression.startsWith('@') || /\s/.test(expression)) {
    return asCron(expression, monitor)
  }

  if (EVERY.test(expression)) {
    return asInterval(expression, monitor)
  }

  refuse(
    `${JSON.stringify(expression)} is neither a cron expression, an interval, nor one of the twelve schedules this service names: ${SIMPLE_SCHEDULES.join(', ')}.`,
    monitor,
  )
}

export function normaliseSchedule(schedule: unknown, monitor: string): NormalisedSchedule {
  if (typeof schedule === 'string') {
    return fromText(schedule, monitor)
  }

  if (typeof schedule !== 'object' || schedule === null) {
    refuse(
      'A schedule is a string, or an object carrying one of every, interval, cron or simple.',
      monitor,
    )
  }

  const given = schedule as Record<string, unknown>

  if (given['every'] !== undefined) {
    return asInterval(given['every'] as string | number, monitor)
  }

  if (given['interval'] !== undefined) {
    return asInterval(given['interval'] as string | number, monitor)
  }

  if (given['cron'] !== undefined) {
    return typeof given['cron'] === 'string'
      ? asCron(given['cron'].trim(), monitor)
      : refuse('A cron schedule is written as a string.', monitor)
  }

  if (given['simple'] !== undefined) {
    return asSimple(given['simple'], monitor)
  }

  refuse(
    'A schedule object carries one of every, interval, cron or simple, and this one carries none of them.',
    monitor,
  )
}

export function describeSchedule(kind: string, expr: string): string {
  return kind === 'interval' ? `every ${expr}s` : `${kind} ${expr}`
}
