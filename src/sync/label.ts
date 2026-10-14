import { withForbiddenRemoved, withForbiddenSpelledOut } from '../api/validate.js'
import { labelFor, looksLikeAnId } from '../ping/resolve.js'

// Read with the refused characters taken out, so one placed before an id cannot stop it
// being recognised as one.
export function isIdShaped(name: string): boolean {
  return looksLikeAnId(withForbiddenRemoved(name))
}

export function monitorLabel(name: string): string {
  return isIdShaped(name) ? labelFor(withForbiddenRemoved(name)) : withForbiddenSpelledOut(labelFor(name))
}
