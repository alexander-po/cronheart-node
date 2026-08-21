import type { MonitorableTask } from '../../src/integrations/node-cron.js'

type Listener = (context: never) => Promise<void> | void

// A stand-in for the half of node-cron's ScheduledTask the adapter touches. The real task
// emits through node's EventEmitter, which neither awaits a listener nor sees what it
// returns, so the fake does the same: anything the adapter needs settled it must hold itself.
export interface FakeTask extends MonitorableTask {
  emit(event: string, context: unknown): void
  listenerCount(event: string): number
}

export function fakeTask(pattern: string, name?: string): FakeTask {
  const listeners = new Map<string, Listener[]>()

  return {
    ...(name === undefined ? {} : { name }),
    getPattern: () => pattern,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener])
    },
    off: (event, listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((known) => known !== (listener as Listener)),
      )
    },
    emit: (event, context) => {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(context as never)
      }
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

export function execution(id: string, extra?: Readonly<Record<string, unknown>>): unknown {
  return { date: new Date(), triggeredAt: new Date(), execution: { id, reason: 'scheduled', ...extra } }
}
