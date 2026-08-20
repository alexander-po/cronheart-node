// A comment that says throw and mentions fetch(url) must not trip the guard.
const advice = 'do not throw here, and do not call fetch(url) either'

export function describe(): string {
  return advice
}
