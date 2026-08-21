export const CRON_FIELD_COUNT = 5

export const CRON_ALIASES = [
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
] as const

const CRON_FIELDS = 'minute, hour, day of month, month, day of week'

const HOUR_FIELD_INDEX = 1

// @hourly is the one alias that fires at the same offset in every zone. The rest name an
// hour of the day, so which zone the scheduler reads them in decides when they fire.
const ZONE_FREE_ALIASES: ReadonlySet<string> = new Set(['@hourly'])

const PURE_STEP = /^\*(\/[0-9]+)?$/

export function cronFields(expression: string): readonly string[] {
  return expression
    .trim()
    .split(/\s+/)
    .filter((field) => field !== '')
}

export function isCronAlias(expression: string): boolean {
  return (CRON_ALIASES as readonly string[]).includes(expression.trim().toLowerCase())
}

// undefined means the service would take the expression exactly as the scheduler was given
// it. Anything else is a sentence naming which dialect wrote it and what to write instead.
export function cronDialectRefusal(expression: string, dialect: string): string | undefined {
  const written = expression.trim()
  const quoted = JSON.stringify(written)

  if (written.startsWith('@')) {
    if (isCronAlias(written)) {
      return undefined
    }

    return `${quoted} is an alias ${dialect} resolves and cronheart does not. The seven it takes are ${CRON_ALIASES.join(', ')} — @reboot is not among them, because nothing on the service ever sees your machine start.`
  }

  const fields = cronFields(written)

  if (fields.length === CRON_FIELD_COUNT) {
    return undefined
  }

  if (fields.length > CRON_FIELD_COUNT) {
    return `${quoted} has ${fields.length} fields. ${dialect} reads the first as seconds; a cronheart schedule has five — ${CRON_FIELDS} — and no seconds field, so the service would refuse it and the monitor's schedule would never be the job's. Drop the leading field and write the schedule in minutes.`
  }

  return `${quoted} has ${fields.length === 1 ? '1 field' : `${fields.length} fields`}. A cronheart schedule has five — ${CRON_FIELDS}.`
}

// A schedule that runs every N minutes fires at the same instants in every zone; one that
// names an hour lands somewhere else when the scheduler and the monitor disagree.
export function readsAsAnHourOfTheDay(expression: string): boolean {
  const written = expression.trim()

  if (written.startsWith('@')) {
    return isCronAlias(written) && !ZONE_FREE_ALIASES.has(written.toLowerCase())
  }

  const fields = cronFields(written)

  if (fields.length !== CRON_FIELD_COUNT) {
    return false
  }

  return !PURE_STEP.test(fields[HOUR_FIELD_INDEX] ?? '*')
}
