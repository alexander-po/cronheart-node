import 'reflect-metadata'
import { Injectable, Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { Cron, type CronOptions, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { describe, expect, it } from 'vitest'
import {
  CronheartModule,
  type ScheduledJobs,
  monitorScheduledJobs,
} from '../src/integrations/nestjs.js'
import { clearWarnings } from '../src/testing.js'
import {
  CronheartConfigurationError,
  InvalidScheduleError,
  InvalidTimezoneError,
  UnknownMonitorError,
} from '../src/wiring/errors.js'
import { ADAPTER_MONITOR, ADAPTER_MONITOR_ID, gate, harness } from './support/adapters.js'
import { explodingRegistry, fakeCronJob, fakeRegistry, opaqueCronJob } from './support/nest-registry.js'

const SCHEDULE = '0 3 * * *'

// The registry's key and the monitor's name differ on purpose: an adapter that ignored the
// mapping and checked in under the job's own key would pass every case where the two agree.
const JOB_KEY = 'nightlyDigest'

const MAPPED = { [JOB_KEY]: ADAPTER_MONITOR }

interface FactoryProvider {
  readonly inject: readonly unknown[]
  useFactory(registry: ScheduledJobs): {
    onApplicationBootstrap(): void
    onApplicationShutdown(): Promise<void>
  }
}

function lines(): { written: string[]; report: (message: string) => void } {
  const written: string[] = []

  return { written, report: (message) => written.push(message) }
}

async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

describe('the nestjs adapter', () => {
  it('wraps the jobs the mapping names and reports what it left uncovered', () => {
    const test = harness()
    const written = lines()
    const registry = fakeRegistry({
      [JOB_KEY]: fakeCronJob(SCHEDULE, () => undefined),
      cleanupTmp: fakeCronJob(SCHEDULE, () => undefined),
      warmCache: fakeCronJob(SCHEDULE, () => undefined),
    })

    const attached = monitorScheduledJobs(registry, {
      jobs: MAPPED,
      client: test.client,
      report: written.report,
    })

    expect(attached.monitored).toEqual([JOB_KEY])
    expect(attached.unmapped).toEqual(['cleanupTmp', 'warmCache'])
    expect(written.written).toEqual([
      expect.stringContaining('monitoring 1 of 3 cron jobs; unmapped: cleanupTmp, warmCache'),
    ])
  })

  it('brackets a fire of a wrapped job and awaits the terminal check-in', async () => {
    const test = harness()
    const produced = { rows: 4 }
    const job = fakeCronJob(SCHEDULE, () => produced)
    const registry = fakeRegistry({ [JOB_KEY]: job })

    monitorScheduledJobs(registry, { jobs: MAPPED, client: test.client, report: () => {} })
    const returned = await job.fire()
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

  it('reports a callback that rejects as a fail check-in and lets the rejection through', async () => {
    const test = harness()
    const failure = new Error('the digest could not be built')
    const job = fakeCronJob(SCHEDULE, () => {
      throw failure
    })

    monitorScheduledJobs(fakeRegistry({ [JOB_KEY]: job }), {
      jobs: MAPPED,
      client: test.client,
      report: () => {},
    })

    const thrown = await job.fire().then(
      () => undefined,
      (error: unknown) => error,
    )
    await test.settled()

    expect(thrown).toBe(failure)
    expect(test.actions()).toEqual(['start', 'fail'])
    expect(test.bodies()[1]).toContain('the digest could not be built')
  })

  it('leaves a job the mapping excludes unwrapped, and out of the uncovered list', async () => {
    const test = harness()
    const written = lines()
    const excluded = fakeCronJob(SCHEDULE, () => undefined)

    const attached = monitorScheduledJobs(
      fakeRegistry({ [JOB_KEY]: fakeCronJob(SCHEDULE, () => undefined), warmCache: excluded }),
      {
        jobs: { ...MAPPED, warmCache: false },
        client: test.client,
        report: written.report,
      },
    )
    await excluded.fire()
    await test.settled()

    expect(attached.unmapped).toEqual([])
    expect(test.actions()).toEqual([])
    expect(written.written).toEqual([expect.stringContaining('monitoring 1 of 1 cron job')])
  })

  it('names a registered job whose callback it cannot reach rather than skipping it quietly', () => {
    const test = harness()
    const written = lines()

    const attached = monitorScheduledJobs(
      fakeRegistry({ [JOB_KEY]: opaqueCronJob(SCHEDULE) }),
      { jobs: MAPPED, client: test.client, report: written.report },
    )

    expect(attached.monitored).toEqual([])
    expect(attached.unwrapped).toEqual([JOB_KEY])
    expect(written.written).toEqual([expect.stringContaining('could not be wrapped')])
  })

  it('says so when the registry holds no cron jobs at all', () => {
    const test = harness()
    const written = lines()

    const attached = monitorScheduledJobs(fakeRegistry({}), {
      jobs: MAPPED,
      client: test.client,
      report: written.report,
    })

    expect(attached.monitored).toEqual([])
    expect(written.written).toEqual([expect.stringContaining('no cron jobs')])
  })

  it('refuses a six-field expression at bootstrap, naming the dialect', () => {
    const test = harness()

    expect(() =>
      monitorScheduledJobs(fakeRegistry({ [JOB_KEY]: fakeCronJob('*/30 * * * * *', () => undefined) }), {
        jobs: MAPPED,
        client: test.client,
        report: () => {},
      }),
    ).toThrow(InvalidScheduleError)
  })

  it('refuses a zone the runtime does not know, and a monitor nothing resolves', () => {
    const test = harness()

    expect(() =>
      monitorScheduledJobs(
        fakeRegistry({ [JOB_KEY]: fakeCronJob(SCHEDULE, () => undefined, 'Europe/Berlim') }),
        { jobs: MAPPED, client: test.client, report: () => {} },
      ),
    ).toThrow(InvalidTimezoneError)

    expect(() =>
      monitorScheduledJobs(fakeRegistry({ [JOB_KEY]: fakeCronJob(SCHEDULE, () => undefined) }), {
        jobs: { [JOB_KEY]: 'a-name-nothing-defines' },
        client: test.client,
        report: () => {},
      }),
    ).toThrow(UnknownMonitorError)
  })

  // The assertion is on the callback's identity, not on how many callbacks the job holds:
  // wrapping replaces one in place, so a count is the same either way and proves nothing.
  it('wraps nothing at all when one mapped job is refused', () => {
    const test = harness()
    const original = (): undefined => undefined
    const sound = fakeCronJob(SCHEDULE, original)

    expect(() =>
      monitorScheduledJobs(
        fakeRegistry({
          [JOB_KEY]: sound,
          everyThirtySeconds: fakeCronJob('*/30 * * * * *', () => undefined),
        }),
        {
          jobs: { ...MAPPED, everyThirtySeconds: ADAPTER_MONITOR },
          client: test.client,
          report: () => {},
        },
      ),
    ).toThrow(InvalidScheduleError)

    expect(sound.callbacks()[0]).toBe(original)
    expect(test.recorder.pings).toEqual([])
  })

  it('puts the job’s own callback back when it is detached', async () => {
    const test = harness()
    const original = () => undefined
    const job = fakeCronJob(SCHEDULE, original)

    const attached = monitorScheduledJobs(fakeRegistry({ [JOB_KEY]: job }), {
      jobs: MAPPED,
      client: test.client,
      report: () => {},
    })
    const whileAttached = job.callbacks()[0]

    attached.detach()
    await job.fire()
    await test.settled()

    expect(whileAttached).not.toBe(original)
    expect(job.callbacks()[0]).toBe(original)
    expect(test.actions()).toEqual([])
  })

  it('collapses overlapping fires into one bracket and names the scheduler’s own guard', async () => {
    clearWarnings()
    const test = harness()
    const held = gate()
    const job = fakeCronJob(SCHEDULE, () => held.held)
    const warnings: string[] = []
    const sink = console.warn
    console.warn = (message: unknown) => {
      warnings.push(String(message))
    }

    try {
      monitorScheduledJobs(fakeRegistry({ [JOB_KEY]: job }), {
        jobs: MAPPED,
        client: test.client,
        report: () => {},
      })

      const first = job.fire()
      const second = job.fire()
      held.release()
      await Promise.all([first, second])
      await test.settled()
    } finally {
      console.warn = sink
    }

    expect(test.actions()).toEqual(['start', 'success'])
    expect(warnings.filter((line) => line.includes('waitForCompletion')).length).toBe(1)
  })

  it('turns a registry that explodes when read into a configuration error', () => {
    const test = harness()
    let thrown: unknown

    try {
      monitorScheduledJobs(explodingRegistry(), {
        jobs: MAPPED,
        client: test.client,
        report: () => {},
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CronheartConfigurationError)
    expect(thrown).not.toBeInstanceOf(TypeError)
  })
})

describe('the nestjs module', () => {
  it('injects the registry token it was handed and walks it when the app boots', async () => {
    const test = harness()
    const written = lines()
    const job = fakeCronJob(SCHEDULE, () => undefined)
    const registry = fakeRegistry({ [JOB_KEY]: job })
    const token = class FakeRegistry {}

    const dynamic = CronheartModule.forRoot({
      registry: token as never,
      jobs: MAPPED,
      client: test.client,
      report: written.report,
    })
    const provider = (dynamic.providers ?? [])[0] as unknown as FactoryProvider

    expect(dynamic.module).toBe(CronheartModule)
    expect(provider.inject).toEqual([token])

    const instance = provider.useFactory(registry)

    expect(test.recorder.pings).toEqual([])

    instance.onApplicationBootstrap()
    await job.fire()
    await instance.onApplicationShutdown()

    expect(written.written).toEqual([expect.stringContaining('monitoring 1 of 1 cron job')])
    expect(test.actions()).toEqual(['start', 'success'])
  })
})

class Digests {
  ran = 0

  async nightlyDigest(): Promise<void> {
    this.ran += 1
  }

  async brokenDigest(): Promise<void> {
    throw new Error('the nest job failed inside its own method')
  }
}

function decorate(key: string, options: CronOptions): void {
  const current = Object.getOwnPropertyDescriptor(Digests.prototype, key) as PropertyDescriptor
  const decorated = (Cron(SCHEDULE, options) as MethodDecorator)(
    Digests.prototype,
    key,
    current,
  ) as PropertyDescriptor | undefined

  Object.defineProperty(Digests.prototype, key, decorated ?? current)
}

decorate('nightlyDigest', { name: JOB_KEY, waitForCompletion: true } as CronOptions)
decorate('brokenDigest', { name: 'brokenDigest', waitForCompletion: true } as CronOptions)
Injectable()(Digests)

// The fakes above describe the scheduler the adapter was written against. This one boots the
// real framework, so a registry key, a job object or a lifecycle hook that is not what we
// think it is fails here rather than in a consumer's application.
describe('the nestjs module against the real scheduler', () => {
  it('monitors a job the framework registered, without the call site changing', async () => {
    const test = harness({ [ADAPTER_MONITOR]: ADAPTER_MONITOR_ID })
    const written = lines()

    class AppModule {}
    Module({
      imports: [
        ScheduleModule.forRoot(),
        CronheartModule.forRoot({
          registry: SchedulerRegistry,
          jobs: { [JOB_KEY]: ADAPTER_MONITOR, brokenDigest: false },
          client: test.client,
          report: written.report,
        }),
      ],
      providers: [Digests],
    })(AppModule)

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false })

    try {
      const registry = app.get(SchedulerRegistry)
      const job = registry.getCronJobs().get(JOB_KEY)

      expect(job).toBeDefined()

      await job?.fireOnTick()
      await ticks(20)
      await test.settled()

      expect(app.get(Digests).ran).toBe(1)
      expect(test.actions()).toEqual(['start', 'success'])
      expect(written.written).toEqual([expect.stringContaining('monitoring 1 of 1 cron job')])
    } finally {
      await app.close()
    }
  })

  // Pinned, not desired: the scheduler catches and logs whatever a decorated method throws
  // before anything outside can see it, so a run that failed inside the method reads as a
  // completed one. The README says so, and this fails if the framework ever stops doing it.
  it('cannot see a failure the scheduler swallows inside its own wrapper', async () => {
    const test = harness({ [ADAPTER_MONITOR]: ADAPTER_MONITOR_ID })

    class AppModule {}
    Module({
      imports: [
        ScheduleModule.forRoot(),
        CronheartModule.forRoot({
          registry: SchedulerRegistry,
          jobs: { brokenDigest: ADAPTER_MONITOR, [JOB_KEY]: false },
          client: test.client,
          report: () => {},
        }),
      ],
      providers: [Digests],
    })(AppModule)

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false })

    try {
      await app.get(SchedulerRegistry).getCronJobs().get('brokenDigest')?.fireOnTick()
      await ticks(20)
      await test.settled()

      expect(test.actions()).toEqual(['start', 'success'])
    } finally {
      await app.close()
    }
  })
})
