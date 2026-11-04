export const NAME_FORBIDDEN_RANGES = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
] as const

function isForbidden(codePoint: number): boolean {
  return NAME_FORBIDDEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
}

// Invisible, direction-marking and look-alike space characters a name may hold but a terminal may not be handed raw.
// Default-ignorable code points and space separators, less the space itself and the four
// that emoji sequences are written with, which stay readable, plus the blank Braille pattern
// and the interlinear annotation marks, which draw as nothing; ranges rather than a property
// escape, so the set does not move with the runtime's Unicode tables.
const UNPRINTED_RANGES = [
  [0x00a0, 0x00a0],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x1680, 0x1680],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x2000, 0x200b],
  [0x200e, 0x200f],
  [0x202f, 0x202f],
  [0x205f, 0x206f],
  [0x2800, 0x2800],
  [0x3000, 0x3000],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0d],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
] as const

function isPrintedEscaped(codePoint: number): boolean {
  return isForbidden(codePoint) || UNPRINTED_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high)
}

export function codePointName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

export function forbiddenIn(value: string): number | undefined {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0

    if (isForbidden(codePoint)) {
      return codePoint
    }
  }

  return undefined
}

// A refused name is still the label a refusal is written under, so the characters that
// refused it, and the invisible ones beside them, are spelled out rather than handed to a
// terminal or a log line raw.
function withForbidden(value: string, written: (codePoint: number) => string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0

      return isPrintedEscaped(codePoint) ? written(codePoint) : character
    })
    .join('')
}

export function withForbiddenSpelledOut(value: string): string {
  return withForbidden(value, codePointName)
}

export function withForbiddenSpelledOutBetween(value: string): string {
  return withForbidden(value, (codePoint) => `<${codePointName(codePoint)}>`)
}

export function withForbiddenRemoved(value: string): string {
  return withForbidden(value.replace(/[\u200C\u200D\uFE0E\uFE0F]/g, ''), () => '')
}
