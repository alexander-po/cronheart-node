import process from 'node:process'
import { countdown, detachedCountdown } from '../timer.js'

export const EXIT_OK = 0

export const EXIT_PROBLEM = 1

export const EXIT_USAGE = 64

export const EXIT_INTERNAL = 70

export const EXIT_TIMED_OUT = 124

export const EXIT_NOT_EXECUTABLE = 126

export const EXIT_NOT_FOUND = 127

export const SIGNAL_EXIT_BASE = 128

const LINGER_BUDGET_MS = 1000

const BUFFERED_STDIO_POLL_MS = 100

// A stream that is no longer writable counts as owing nothing: whatever it still holds is
// never going out, and waiting on it would hold the process open for good.
function buffered(stream: { writable?: boolean; writableLength?: number }): number {
  return stream.writable === true && typeof stream.writableLength === 'number'
    ? stream.writableLength
    : 0
}

function bufferedStdio(): number {
  return buffered(process.stdout) + buffered(process.stderr)
}

// A queued stdio write neither holds this process open nor survives its exit, so a tee into a
// reader slower than the command wrote would lose its tail at either end of the budget below.
function holdWhileStdioIsBuffered(): void {
  if (bufferedStdio() === 0) {
    return
  }

  void countdown(BUFFERED_STDIO_POLL_MS).reached.then(holdWhileStdioIsBuffered)
}

function exitOnceStdioIsFlushed(code: number): void {
  if (bufferedStdio() === 0) {
    process.exit(code)

    return
  }

  void detachedCountdown(BUFFERED_STDIO_POLL_MS).reached.then(() => {
    exitOnceStdioIsFlushed(code)
  })
}

// A pooled keep-alive socket can outlive the check-in that opened it, so the exit code is
// recorded first and the forced exit is detached: a process with nothing else pending still
// ends immediately, and one held open by the pool ends anyway with the code already set.
export function finish(code: number): void {
  process.exitCode = code

  const linger = detachedCountdown(LINGER_BUDGET_MS)

  void linger.reached.then(() => {
    exitOnceStdioIsFlushed(code)
  })

  holdWhileStdioIsBuffered()
}
