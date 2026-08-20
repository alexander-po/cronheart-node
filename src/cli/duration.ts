// setTimeout holds a 32-bit signed millisecond delay; anything larger fires after 1 ms.
export const MAX_TIMER_MS = 2_147_483_647

const DURATION = /^([0-9]+)(ms|s|m|h)?$/

const SCALE: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

export function parseDuration(value: string): number | undefined {
  const match = DURATION.exec(value.trim())

  if (match === null) {
    return undefined
  }

  const amount = Number(match[1])
  const scale = SCALE[match[2] ?? 's'] ?? 1000
  const total = amount * scale

  return Number.isSafeInteger(total) ? total : undefined
}

export function describeDuration(ms: number): string {
  if (ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`
  }

  if (ms % 60_000 === 0) {
    return `${ms / 60_000}m`
  }

  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
