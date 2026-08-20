import { MAX_RETRIES } from '../constants.js'

declare const bounded: unique symbol

// Branded, so the only way to hold an attempt count is to have been given a capped one:
// neither request type carries an unbounded retry field a second loop could derive from.
export type Attempts = number & { readonly [bounded]: true }

export function attemptsFor(retries: number): Attempts {
  return Math.min(Math.max(1, retries + 1), MAX_RETRIES + 1) as Attempts
}
