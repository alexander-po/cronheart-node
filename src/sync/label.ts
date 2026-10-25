import { withForbiddenRemoved, withForbiddenSpelledOut, withForbiddenSpelledOutBetween } from '../api/validate.js'
import { labelFor, looksLikeAnId, withIdsCut } from '../ping/resolve.js'

// Read with the refused characters taken out, so one placed before an id cannot stop it
// being recognised as one.
export function isIdShaped(name: string): boolean {
  return looksLikeAnId(withForbiddenRemoved(name).trim())
}

export function monitorLabel(name: string): string {
  return isIdShaped(name) ? labelFor(withForbiddenRemoved(name).trim()) : printedBare(labelFor(name))
}

// A monitor id is the whole check-in capability, so text shaped like one is cut as a
// monitor's label is, wherever in it the id sits; any other text has its refused and
// invisible characters spelled out. Only a name is cut for merely opening like an id: a
// channel label or a zone that happens to open with a date is not a mistyped one.
function printedWith(text: string, spell: (value: string) => string, openingCuts: boolean): string {
  const flat = withForbiddenRemoved(text).trim()

  if (openingCuts && isIdShaped(text)) {
    return labelFor(flat)
  }

  return withIdsCut(flat) !== flat ? withIdsCut(flat) : spell(text)
}

export function printed(text: string): string {
  return printedWith(text, withForbiddenSpelledOutBetween, true)
}

export function printedBetween(text: string): string {
  return printedWith(text, withForbiddenSpelledOutBetween, false)
}

export function printedBare(text: string): string {
  return printedWith(text, withForbiddenSpelledOut, false)
}
