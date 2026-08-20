interface State {
  readonly sinks: unknown[][]
  readonly leaked: unknown[]
}

const STATE_KEY = Symbol.for('cronheart.test.unhandledRejections')

function state(): State {
  const host = globalThis as unknown as Record<symbol, unknown>
  const existing = host[STATE_KEY]

  if (existing !== undefined) {
    return existing as State
  }

  const created: State = { sinks: [], leaked: [] }
  host[STATE_KEY] = created
  process.on('unhandledRejection', (reason: unknown) => {
    if (created.sinks.length === 0) {
      created.leaked.push(reason)

      return
    }

    for (const sink of created.sinks) {
      sink.push(reason)
    }
  })

  return created
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export function drainLeakedRejections(): unknown[] {
  return state().leaked.splice(0)
}

export async function captureUnhandledRejections<T>(
  run: () => Promise<T>,
): Promise<{ value: T; unhandled: unknown[] }> {
  const current = state()
  const collected: unknown[] = []
  current.sinks.push(collected)

  try {
    const value = await run()
    await nextMacrotask()
    await nextMacrotask()

    return { value, unhandled: [...collected] }
  } finally {
    current.sinks.splice(current.sinks.indexOf(collected), 1)
  }
}
