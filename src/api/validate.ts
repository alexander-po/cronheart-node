import {
  API_PAGE_LIMIT_MAX,
  CHANNEL_KINDS,
  CHANNEL_LABEL_MAX_LENGTH,
  CHANNEL_LABEL_MIN_LENGTH,
  CRON_ALIASES,
  CRON_FIELD_COUNT,
  INTERVAL_SECONDS_MAX,
  INTERVAL_SECONDS_MIN,
  MONITOR_GRACE_SECONDS_MAX,
  MONITOR_GRACE_SECONDS_MIN,
  MONITOR_NAME_MAX_LENGTH,
  MONITOR_NAME_MIN_LENGTH,
  SCHEDULE_EXPR_MAX_LENGTH,
  SCHEDULE_KINDS,
  SIMPLE_SCHEDULES,
  SNOOZE_DURATIONS,
  TIMEZONE_MAX_LENGTH,
} from './constants.js'
import { ApiInvalidRequestError } from './errors.js'
import type { ChannelKind, ScheduleKind, SnoozeDuration } from './types.js'

const MONITOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The identifier is 64-bit and arrives as a decimal string on every read. A value that is
// not digits is coerced to zero on the write side, which then fails an ownership check
// naming channel zero rather than the value sent — so it is refused before the request
// exists, and it is never parsed into a number, which would lose the far end of the range.
const CHANNEL_ID = /^[0-9]+$/

const ASCII_DIGITS = /^[0-9]+$/

function refuse(message: string): never {
  throw new ApiInvalidRequestError(message)
}

function oneOf(members: readonly string[]): string {
  return members.join(', ')
}

export function assertMonitorUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !MONITOR_UUID.test(value)) {
    refuse(
      'That is not a monitor identifier. An identifier is 36 characters, hexadecimal in groups of 8-4-4-4-12, and appears on the monitor’s page.',
    )
  }
}

export function channelIdFor(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      refuse('A channel identifier must be a whole, non-negative number.')
    }

    return String(value)
  }

  if (typeof value !== 'string' || !CHANNEL_ID.test(value)) {
    refuse(
      'A channel identifier is a run of digits, exactly as the channels listing reports it.',
    )
  }

  return value.replace(/^0+(?=[0-9])/, '')
}

export function channelIdsFor(values: readonly (string | number)[]): readonly string[] {
  if (!Array.isArray(values)) {
    refuse('channelIds must be an array. A value of another shape is rejected, not ignored.')
  }

  return values.map(channelIdFor)
}

export function assertScheduleKind(value: unknown): asserts value is ScheduleKind {
  if (typeof value !== 'string' || !SCHEDULE_KINDS.includes(value as ScheduleKind)) {
    refuse(`scheduleKind must be one of ${oneOf(SCHEDULE_KINDS)}.`)
  }
}

export function assertChannelKind(value: unknown): asserts value is ChannelKind {
  if (typeof value !== 'string' || !CHANNEL_KINDS.includes(value as ChannelKind)) {
    refuse(`A channel kind must be one of ${oneOf(CHANNEL_KINDS)}.`)
  }
}

export function assertSnoozeDuration(value: unknown): asserts value is SnoozeDuration {
  if (typeof value !== 'string' || !SNOOZE_DURATIONS.includes(value as SnoozeDuration)) {
    refuse(`A snooze duration must be one of ${oneOf(SNOOZE_DURATIONS)}.`)
  }
}

function assertBounded(value: unknown, field: string, min: number, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${field} must be a non-empty string.`)
  }

  if (value.length < min || value.length > max) {
    refuse(`${field} must be between ${min} and ${max} characters.`)
  }
}

export function assertMonitorName(value: unknown): asserts value is string {
  assertBounded(value, 'name', MONITOR_NAME_MIN_LENGTH, MONITOR_NAME_MAX_LENGTH)
}

export function assertChannelLabel(value: unknown): asserts value is string {
  assertBounded(value, 'label', CHANNEL_LABEL_MIN_LENGTH, CHANNEL_LABEL_MAX_LENGTH)
}

export function assertTimezone(value: unknown): asserts value is string {
  assertBounded(value, 'tz', 1, TIMEZONE_MAX_LENGTH)
}

export function assertGraceSeconds(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MONITOR_GRACE_SECONDS_MIN ||
    value > MONITOR_GRACE_SECONDS_MAX
  ) {
    refuse(
      `graceSeconds must be a whole number between ${MONITOR_GRACE_SECONDS_MIN} and ${MONITOR_GRACE_SECONDS_MAX}.`,
    )
  }
}

function assertCron(expression: string): void {
  if (CRON_ALIASES.includes(expression.toLowerCase() as (typeof CRON_ALIASES)[number])) {
    return
  }

  if (expression.startsWith('@')) {
    refuse(
      `The only schedule aliases this service accepts are ${oneOf(CRON_ALIASES)}. @reboot has no meaning to a service that never sees your machine start.`,
    )
  }

  const fields = expression.trim().split(/\s+/)

  if (fields.length === CRON_FIELD_COUNT) {
    return
  }

  refuse(
    fields.length > CRON_FIELD_COUNT
      ? `This service reads ${CRON_FIELD_COUNT}-field cron expressions, and this one has ${fields.length}. Several Node schedulers accept a sixth leading seconds field; drop it and express the schedule in minutes.`
      : `A cron expression has ${CRON_FIELD_COUNT} fields — minute, hour, day of month, month, day of week — and this one has ${fields.length}.`,
  )
}

function assertInterval(expression: string): void {
  // ASCII digits only, as a string. A Unicode-aware digit test would accept expressions the
  // service rejects, which is the kind of difference a port silently introduces.
  if (!ASCII_DIGITS.test(expression)) {
    refuse('An interval schedule is a whole number of seconds written in ASCII digits.')
  }

  const seconds = Number(expression)

  if (seconds < INTERVAL_SECONDS_MIN || seconds > INTERVAL_SECONDS_MAX) {
    refuse(
      `An interval must be between ${INTERVAL_SECONDS_MIN} and ${INTERVAL_SECONDS_MAX} seconds.`,
    )
  }
}

function assertSimple(expression: string): void {
  if (!SIMPLE_SCHEDULES.includes(expression as (typeof SIMPLE_SCHEDULES)[number])) {
    refuse(
      `A simple schedule is one of ${oneOf(SIMPLE_SCHEDULES)}. It is a fixed set of tokens, not free text.`,
    )
  }
}

export function assertScheduleExprShape(expression: unknown): asserts expression is string {
  assertBounded(expression, 'scheduleExpr', 1, SCHEDULE_EXPR_MAX_LENGTH)
}

export function assertScheduleExpression(
  kind: ScheduleKind,
  expression: unknown,
): asserts expression is string {
  assertScheduleExprShape(expression)

  if (kind === 'cron') {
    assertCron(expression)
  } else if (kind === 'interval') {
    assertInterval(expression)
  } else {
    assertSimple(expression)
  }
}

// Clamped rather than passed through: the service silently raises a limit below one and
// lowers one above the maximum, and a pager that then compared its own request against the
// echoed limit would read every page as a short one and stop after the first.
export function pageLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    refuse('limit must be a whole number of at least 1.')
  }

  return Math.min(value, API_PAGE_LIMIT_MAX)
}

export function pageOffset(value: number | undefined): number {
  if (value === undefined) {
    return 0
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    refuse('offset must be a whole number of at least 0.')
  }

  return value
}
