import { describe, expect, it } from 'vitest'
import { monitor } from '../src/integrations/node-cron.js'
import { InvalidScheduleError, UnknownMonitorError } from '../src/wiring/errors.js'
import { clearWarnings } from '../src/testing.js'
import { ADAPTER_MONITOR, ADAPTER_MONITOR_ID, harness } from './support/adapters.js'
import { execution, fakeTask } from './support/node-cron-task.js'

describe('the node-cron v4 adapter', () => {
  it('brackets an execution from its start event to its finish event', async () => {
    const test = harness()
    const task = fakeTask('0 3 * * *')
    const attached = monitor(task, ADAPTER_MONITOR, { client: test.client })

    task.emit('execution:started', execution('e1'))
    task.emit('execution:finished', execution('e1', { result: 'done' }))
    await attached.flush(1000)

    expect(test.actions()).toEqual(['start', 'success'])
    expect(test.recorder.pings.map((ping) => ping.monitorId)).toEqual([
      ADAPTER_MONITOR_ID,
      ADAPTER_MONITOR_ID,
    ])
  })

  it('reports a failed execution as a fail check-in carrying node-cron’s own error', async () => {
    const test = harness()
    const task = fakeTask('0 3 * * *')
    const attached = monitor(task, ADAPTER_MONITOR, { client: test.client })

    task.emit('execution:started', execution('e1'))
    task.emit(
      'execution:failed',
      execution('e1', { error: new Error('the archive step exited non-zero') }),
    )
    await attached.flush(1000)

    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('the archive step exited non-zero')
  })

  // A file-path task reports through the same events from a forked process, where node-cron
  // emits on a bare EventEmitter: a listener that threw there would take the daemon's
  // message handler with it. Nothing the adapter reads off the context may escape.
  it('survives an event whose context refuses to be read', async () => {
    const test = harness()
    const task = fakeTask('0 3 * * *')
    const hostile = {
      get execution(): never {
        throw new TypeError('the execution exploded when read')
      },
    }
    const attached = monitor(task, ADAPTER_MONITOR, { client: test.client })

    expect(() => task.emit('execution:started', hostile)).not.toThrow()
    expect(() => task.emit('execution:finished', hostile)).not.toThrow()
    await attached.flush(1000)
  })

  it('collapses overlapping executions into one bracket and names node-cron’s own guard', async () => {
    clearWarnings()
    const test = harness()
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }
    const task = fakeTask('* * * * *')
    const attached = monitor(task, ADAPTER_MONITOR, { client: test.client })

    try {
      task.emit('execution:started', execution('e1'))
      task.emit('execution:started', execution('e2'))
      task.emit('execution:finished', execution('e1'))
      task.emit('execution:finished', execution('e2'))
      await attached.flush(1000)
    } finally {
      console.warn = sink
    }

    expect(test.actions()).toEqual(['start', 'success'])
    expect(warnings.filter((line) => line.includes('noOverlap: true')).length).toBe(1)
  })

  it('takes its listeners off the task again when it is detached', async () => {
    const test = harness()
    const task = fakeTask('0 3 * * *')
    const attached = monitor(task, ADAPTER_MONITOR, { client: test.client })
    const whileAttached = task.listenerCount('execution:started')

    attached.detach()
    task.emit('execution:started', execution('e1'))
    task.emit('execution:finished', execution('e1'))
    await attached.flush(1000)

    expect(whileAttached).toBe(1)
    expect(task.listenerCount('execution:started')).toBe(0)
    expect(test.actions()).toEqual([])
  })

  it('refuses a six-field pattern at attach time, naming node-cron’s dialect', () => {
    const test = harness()

    expect(() => monitor(fakeTask('*/30 * * * * *'), ADAPTER_MONITOR, { client: test.client }))
      .toThrow(InvalidScheduleError)
    expect(test.recorder.pings).toEqual([])
  })

  it('refuses a monitor nothing resolves at attach time', () => {
    const test = harness()

    expect(() =>
      monitor(fakeTask('0 3 * * *'), 'a-name-nothing-defines', { client: test.client }),
    ).toThrow(UnknownMonitorError)
  })

  it('reads the monitor name off the task when none is given', async () => {
    const test = harness({ 'named-by-the-task': ADAPTER_MONITOR_ID })
    const task = fakeTask('0 3 * * *', 'named-by-the-task')
    const attached = monitor(task, undefined, { client: test.client })

    task.emit('execution:started', execution('e1'))
    task.emit('execution:finished', execution('e1'))
    await attached.flush(1000)

    expect(test.actions()).toEqual(['start', 'success'])
  })
})
