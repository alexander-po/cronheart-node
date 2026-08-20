import process from 'node:process'
import { detachedCountdown } from '../timer.js'

export const EXIT_OK = 0

export const EXIT_PROBLEM = 1

export const EXIT_USAGE = 64

export const EXIT_INTERNAL = 70

export const EXIT_TIMED_OUT = 124

export const EXIT_NOT_EXECUTABLE = 126

export const EXIT_NOT_FOUND = 127

export const SIGNAL_EXIT_BASE = 128

const LINGER_BUDGET_MS = 3000

// A pooled keep-alive socket can outlive the check-in that opened it, so the exit code is
// recorded first and the forced exit is detached: a process with nothing else pending still
// ends immediately, and one held open by the pool ends anyway with the code already set.
export function finish(code: number): void {
  process.exitCode = code

  const linger = detachedCountdown(LINGER_BUDGET_MS)

  void linger.reached.then(() => {
    process.exit(code)
  })
}
