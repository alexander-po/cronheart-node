// A comment that says throw and mentions fetch(url) must not trip the guard.
const advice = 'do not throw here, and do not call fetch(url) either'

export function describe(): string {
  return `${advice} — ${`nor nested: throw, fetch(url)`}`
}

// "retries" in prose, and a bounded count that came from somewhere that owns the cap.
export function again(attempts: number): number {
  let attempt = 0

  while (attempt < attempts) {
    attempt += 1
  }

  return attempt
}
