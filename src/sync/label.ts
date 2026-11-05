import { withForbiddenSpelledOutBetween } from '../print-set.js'
import { idMark, labelFor, looksLikeAnId } from '../ping/resolve.js'

// A monitor id is the whole check-in capability, so text holding one is shown as a monitor's
// label is, by the id's last four digits alone; any other text has its refused and invisible
// characters spelled out. Only a name is cut for merely opening like an id: a channel label or a zone that
// happens to open with a date is not a mistyped one.
export function printed(text: string): string {
  return looksLikeAnId(text) ? labelFor(text) : printedBetween(text)
}

export function printedBetween(text: string): string {
  return idMark(text) ?? withForbiddenSpelledOutBetween(text)
}
