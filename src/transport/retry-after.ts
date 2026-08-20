const MAX_SECONDS = 2147483647

const DELTA_SECONDS = /^[0-9]+$/

const IMF_FIXDATE =
  /^[A-Za-z]{3}, ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/

const RFC_850 =
  /^[A-Za-z]+day, ([0-9]{2})-([A-Za-z]{3})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/

const ASCTIME = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ 0-9][0-9]) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.toLowerCase())
}

function utcFrom(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const outOfRange =
    month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60

  return outOfRange ? undefined : Date.UTC(year, month, day, hour, minute, second)
}

function fullYear(twoDigits: number, now: number): number {
  const candidate = 2000 + twoDigits

  return candidate - new Date(now).getUTCFullYear() > 50 ? 1900 + twoDigits : candidate
}

function parseHttpDate(value: string, now: number): number | undefined {
  const fixdate = IMF_FIXDATE.exec(value)

  if (fixdate !== null) {
    return utcFrom(
      Number(fixdate[3]),
      monthIndex(String(fixdate[2])),
      Number(fixdate[1]),
      Number(fixdate[4]),
      Number(fixdate[5]),
      Number(fixdate[6]),
    )
  }

  const obsolete = RFC_850.exec(value)

  if (obsolete !== null) {
    return utcFrom(
      fullYear(Number(obsolete[3]), now),
      monthIndex(String(obsolete[2])),
      Number(obsolete[1]),
      Number(obsolete[4]),
      Number(obsolete[5]),
      Number(obsolete[6]),
    )
  }

  const asctime = ASCTIME.exec(value)

  if (asctime !== null) {
    return utcFrom(
      Number(asctime[6]),
      monthIndex(String(asctime[1])),
      Number(asctime[2]),
      Number(asctime[3]),
      Number(asctime[4]),
      Number(asctime[5]),
    )
  }

  return undefined
}

export function parseRetryAfter(
  header: string | null | undefined,
  now: number,
): number | undefined {
  if (typeof header !== 'string') {
    return undefined
  }

  const value = header.trim()

  if (value === '') {
    return undefined
  }

  if (DELTA_SECONDS.test(value)) {
    const seconds = Number(value)

    return Number.isSafeInteger(seconds) && seconds <= MAX_SECONDS ? seconds : undefined
  }

  const instant = parseHttpDate(value, now)

  if (instant === undefined || Number.isNaN(instant)) {
    return undefined
  }

  const seconds = Math.max(0, Math.floor((instant - now) / 1000))

  return seconds <= MAX_SECONDS ? seconds : undefined
}
