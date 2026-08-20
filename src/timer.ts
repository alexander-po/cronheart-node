export interface Countdown {
  readonly reached: Promise<void>
  cancel(): void
}

function schedule(ms: number, detached: boolean): Countdown {
  let handle: ReturnType<typeof setTimeout> | undefined
  const reached = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms)

    if (detached && typeof (handle as { unref?: () => void }).unref === 'function') {
      ;(handle as { unref: () => void }).unref()
    }
  })

  return {
    reached,
    cancel: () => {
      if (handle !== undefined) {
        clearTimeout(handle)
      }
    },
  }
}

export function countdown(ms: number): Countdown {
  return schedule(ms, false)
}

// Nothing waits on a detached countdown, so it must not be the reason a process stays up.
export function detachedCountdown(ms: number): Countdown {
  return schedule(ms, true)
}
