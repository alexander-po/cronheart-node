import type { Job, Processor, WorkerOptions } from 'bullmq'
import { describe, expect, it } from 'vitest'
import { type BullMqMonitorOptions, monitored } from '../src/integrations/bullmq.js'
import { clearWarnings } from '../src/testing.js'
import { CronheartConfigurationError, UnknownMonitorError } from '../src/wiring/errors.js'
import { ADAPTER_MONITOR, ADAPTER_MONITOR_ID, harness } from './support/adapters.js'
import { fakeJob, hostileJob } from './support/bullmq-job.js'

const JOB = 'nightly-digest'

const QUEUE = 'digests'

// The job name and the monitor name differ on purpose: an adapter that ignored the mapping
// and checked in under the job's own name would pass every case where the two agree.
const MAPPED = { [JOB]: ADAPTER_MONITOR }

function workerOptions(concurrency?: number): WorkerOptions {
  return { connection: { host: 'localhost', port: 6379 }, ...(concurrency === undefined ? {} : { concurrency }) } as WorkerOptions
}

function wrap(
  run: (job: Job) => unknown,
  options: Partial<BullMqMonitorOptions> & Pick<BullMqMonitorOptions, 'client'>,
  concurrency?: number,
): (job: Job) => Promise<unknown> {
  const processor = ((job: Job) => Promise.resolve(run(job))) as Processor
  const args = monitored(QUEUE, workerOptions(concurrency), processor, {
    jobs: MAPPED,
    ...options,
  })

  return args[1] as unknown as (job: Job) => Promise<unknown>
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const sink = console.warn
  console.warn = (message: unknown) => {
    lines.push(String(message))
  }

  return { lines, restore: () => (console.warn = sink) }
}

describe('the bullmq adapter', () => {
  it('hands the worker its own argument list back, queue name and options untouched', () => {
    const test = harness()
    const options = workerOptions(1)
    const processor = (() => Promise.resolve(undefined)) as Processor
    const args = monitored(QUEUE, options, processor, { jobs: MAPPED, client: test.client })

    expect(args[0]).toBe(QUEUE)
    expect(args[2]).toBe(options)
    expect(args[1]).not.toBe(processor)
    expect(args.length).toBe(3)
  })

  it('brackets a repeating job and awaits the terminal check-in before the processor settles', async () => {
    const test = harness()
    const produced = { sent: 12 }
    const process = wrap(() => produced, { client: test.client })

    const returned = await process(fakeJob())
    const beforeFlush = [...test.actions()]
    await test.settled()

    expect(returned).toBe(produced)
    expect(beforeFlush).toContain('success')
    expect(test.actions()).toEqual(['start', 'success'])
    expect(test.recorder.pings.map((ping) => ping.monitorId)).toEqual([
      ADAPTER_MONITOR_ID,
      ADAPTER_MONITOR_ID,
    ])
  })

  it('reports the failure only once the job has exhausted its attempts', async () => {
    const test = harness()
    const failure = new Error('the digest could not reach the mail service')
    const process = wrap(
      () => {
        throw failure
      },
      { client: test.client },
    )

    const firstThrown = await process(fakeJob({ attempts: 3, attemptsStarted: 1 })).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()
    const afterFirstAttempt = [...test.actions()]

    const lastThrown = await process(fakeJob({ attempts: 3, attemptsStarted: 3 })).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(firstThrown).toBe(failure)
    expect(lastThrown).toBe(failure)
    expect(afterFirstAttempt).toEqual(['start'])
    expect(test.actions()).toEqual(['start', 'start', 'fail'])
    expect(test.bodies()[2]).toContain('the digest could not reach the mail service')
  })

  it('treats a job configured for a single attempt as final the first time it fails', async () => {
    const test = harness()
    const process = wrap(
      () => {
        throw new Error('the digest failed')
      },
      { client: test.client },
    )

    await process(fakeJob()).catch(() => undefined)
    await test.settled()

    expect(test.actions()).toEqual(['start', 'fail'])
  })

  it('checks in for nothing on a job that is not on a repeating schedule, and says so once', async () => {
    clearWarnings()
    const test = harness()
    const produced = { sent: 1 }
    const process = wrap(() => produced, { client: test.client })
    const warnings = capture()

    let returned: unknown
    try {
      returned = await process(fakeJob({ oneOff: true }))
      await process(fakeJob({ oneOff: true }))
      await test.settled()
    } finally {
      warnings.restore()
    }

    expect(returned).toBe(produced)
    expect(test.actions()).toEqual([])
    expect(warnings.lines.filter((line) => line.includes('allowOneOff')).length).toBe(1)
  })

  it('checks in for a one-off job when the caller asks for it explicitly', async () => {
    const test = harness()
    const process = wrap(() => undefined, { client: test.client, allowOneOff: true })

    await process(fakeJob({ oneOff: true }))
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
  })

  it('sends no start check-in when the worker runs jobs in parallel, and says why once', async () => {
    clearWarnings()
    const test = harness()
    const warnings = capture()

    let process: (job: Job) => Promise<unknown>
    try {
      process = wrap(() => undefined, { client: test.client }, 5)
    } finally {
      warnings.restore()
    }

    await process(fakeJob())
    await test.settled()

    expect(test.actions()).toEqual(['success'])
    expect(warnings.lines.filter((line) => line.includes('concurrency')).length).toBe(1)
  })

  it('still sends the start check-in under parallelism when the caller asks for it', async () => {
    const test = harness()
    const process = wrap(() => undefined, { client: test.client, pingStart: true }, 5)

    await process(fakeJob())
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
  })

  it('reports a failure without a start check-in when starts are off', async () => {
    const test = harness()
    const failure = new Error('the parallel digest failed')
    const process = wrap(
      () => {
        throw failure
      },
      { client: test.client },
      5,
    )

    const thrown = await process(fakeJob()).then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(thrown).toBe(failure)
    expect(test.actions()).toEqual(['fail'])
    expect(test.bodies()[0]).toContain('the parallel digest failed')
  })

  it('leaves a job nobody mapped alone, value and all', async () => {
    const test = harness()
    const produced = { sent: 0 }
    const process = wrap(() => produced, { client: test.client })

    const returned = await process(fakeJob({ name: 'a-job-nobody-mapped' }))
    await test.settled()

    expect(returned).toBe(produced)
    expect(test.actions()).toEqual([])
  })

  // The mapped job runs in the same case on purpose: an excluded job and a job nobody
  // mapped are indistinguishable here, so a pair of absences would hold just as well with
  // no wrapper installed at all.
  it('says nothing at all about a job the mapping deliberately excludes', async () => {
    clearWarnings()
    const test = harness()
    const warnings = capture()
    const args = monitored(QUEUE, workerOptions(), (() => Promise.resolve()) as Processor, {
      jobs: { ...MAPPED, 'warm-cache': false },
      client: test.client,
    })
    const process = args[1] as unknown as (job: Job) => Promise<unknown>

    try {
      await process(fakeJob({ name: 'warm-cache', oneOff: true }))
      await test.settled()
      const afterTheExcludedJob = [...test.actions()]

      await process(fakeJob())
      await test.settled()

      expect(afterTheExcludedJob).toEqual([])
      expect(test.actions()).toEqual(['start', 'success'])
      expect(warnings.lines).toEqual([])
    } finally {
      warnings.restore()
    }
  })

  it('survives a job every read of which explodes, and still runs the processor', async () => {
    const test = harness()
    const produced = { sent: 3 }
    const process = wrap(() => produced, { client: test.client })

    const returned = await process(hostileJob())
    await test.settled()

    expect(returned).toBe(produced)
  })

  it('warns once when the repeat pattern is one the service would refuse', async () => {
    clearWarnings()
    const test = harness()
    const process = wrap(() => undefined, { client: test.client })
    const warnings = capture()

    try {
      await process(fakeJob({ pattern: '*/30 * * * * *' }))
      await process(fakeJob({ pattern: '*/30 * * * * *' }))
      await test.settled()
    } finally {
      warnings.restore()
    }

    expect(warnings.lines.filter((line) => line.includes('6 fields')).length).toBe(1)
    expect(test.actions()).toEqual(['start', 'success', 'start', 'success'])
  })

  it('refuses a monitor nothing resolves where the worker is wired', () => {
    const test = harness()

    expect(() =>
      monitored(QUEUE, workerOptions(), (() => Promise.resolve()) as Processor, {
        jobs: { [JOB]: 'a-name-nothing-defines' },
        client: test.client,
      }),
    ).toThrow(UnknownMonitorError)
  })

  // Every adapter reads its own options off an object the host wrote, and a getter on one
  // can throw. What leaves the call has to be the type the caller was told to catch.
  it('turns an options object that explodes when read into a configuration error', () => {
    const test = harness()
    const hostile: Record<string, unknown> = { jobs: MAPPED, client: test.client }
    Object.defineProperty(hostile, 'timeoutMs', {
      enumerable: true,
      get: () => {
        throw new TypeError('the timeout the caller passed in exploded')
      },
    })

    let thrown: unknown
    try {
      monitored(
        QUEUE,
        workerOptions(),
        (() => Promise.resolve()) as Processor,
        hostile as unknown as BullMqMonitorOptions,
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CronheartConfigurationError)
    expect(thrown).not.toBeInstanceOf(TypeError)
  })

  // The worker's own options are the scheduler's, not ours: an exploding one is read
  // through the guard and the worker is left with the check-ins a single-file worker gets,
  // rather than with a wiring error over an option that was never the monitor's business.
  it('reads worker options that explode without letting them out', async () => {
    const test = harness()
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'concurrency', {
      enumerable: true,
      get: () => {
        throw new TypeError('the concurrency the caller passed in exploded')
      },
    })

    const args = monitored(QUEUE, hostile as unknown as WorkerOptions, (() => Promise.resolve()) as Processor, {
      jobs: MAPPED,
      client: test.client,
    })
    await (args[1] as unknown as (job: Job) => Promise<unknown>)(fakeJob())
    await test.settled()

    expect(test.actions()).toEqual(['start', 'success'])
  })
})
