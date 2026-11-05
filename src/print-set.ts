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

// The ranges above, the joiners emoji are written with among them, as one pattern of the
// properties they are drawn from, so removing them costs the ping path no copy of the range
// table. A test holds the two equal over every code point.
const INVISIBLE = /(?! )[\p{Cc}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\ufff9-\ufffb]/gu

export function withForbiddenRemoved(value: string): string {
  return value.replace(INVISIBLE, '')
}

// What a monitor's label spells out: controls, direction marks and overrides, and every
// character that draws as nothing, those Unicode marks as ignorable among them. Kept as written: spaces of every
// width, the joiners and variation selectors emoji sequences are written with, and a subdivision
// flag, whose tag characters spell its region.
const UNPRINTED_IN_A_LABEL =
  /\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|[\0-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069\u2800\ufff9-\ufffb\u{13430}-\u{1343f}\p{Default_Ignorable_Code_Point}]/gu

const KEPT_IN_A_LABEL = /^(?:\u{1F3F4}.+|[\u200C\u200D\uFE0E\uFE0F])$/u

function withLabelControls(value: string, written: (character: string) => string): string {
  return value.replace(UNPRINTED_IN_A_LABEL, (found) => (KEPT_IN_A_LABEL.test(found) ? found : written(found)))
}

export function withLabelControlsSpelledOut(value: string): string {
  return withLabelControls(value, (character) => codePointName(character.codePointAt(0) ?? 0))
}

export function withLabelControlsRemoved(value: string): string {
  return withLabelControls(value, () => '')
}
