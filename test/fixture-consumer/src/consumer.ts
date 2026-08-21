import type { DynamicModule } from '@nestjs/common'
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { type Job as QueueJob, Worker } from 'bullmq'
import { Cron } from 'croner'
import { CronJob } from 'cron'
import nodeCron from 'node-cron'
import type { ScheduledTask } from 'node-cron'
import { type Job, scheduleJob } from 'node-schedule'
import { monitored as monitoredByCroner } from 'cronheart/croner'
import { monitored as monitoredByCron } from 'cronheart/cron'
import { monitor as monitorNodeCronTask } from 'cronheart/node-cron'
import type { MonitoredTask } from 'cronheart/node-cron'
import { monitored as monitoredBySchedule } from 'cronheart/node-schedule'
import { monitored as monitoredByBullMq } from 'cronheart/bullmq'
import { CronheartModule, monitorScheduledJobs } from 'cronheart/nestjs'
import type { MonitoredSchedule, ScheduledJobs } from 'cronheart/nestjs'
import {
  PING_BODY_CAP_BYTES,
  PING_EMITTABLE_ACTIONS,
  SDK_VERSION,
  checkIn,
  checkInWith,
  createPingClient,
  describePingResult,
  isMonitorId,
  monitors,
  startRun,
  userAgent,
  withMonitor,
} from 'cronheart'
import type {
  CheckInThunk,
  FetchLike,
  MonitorRun,
  PingAction,
  PingClient,
  PingClientOptions,
  PingOptions,
  PingResult,
} from 'cronheart'

export type PublishedSurface = {
  readonly root: typeof import('cronheart')
  readonly api: typeof import('cronheart/api')
  readonly sync: typeof import('cronheart/sync')
  readonly testing: typeof import('cronheart/testing')
  readonly croner: typeof import('cronheart/croner')
  readonly cron: typeof import('cronheart/cron')
  readonly nodeCron: typeof import('cronheart/node-cron')
  readonly nodeSchedule: typeof import('cronheart/node-schedule')
  readonly bullmq: typeof import('cronheart/bullmq')
  readonly nestjs: typeof import('cronheart/nestjs')
}

export function describeClient(): string {
  return `${SDK_VERSION} via ${userAgent()} (body cap ${PING_BODY_CAP_BYTES})`
}

// The documented transport hook, implemented the way a consumer implements it: the init
// goes straight to a real fetch, so a member the SDK types loosely surfaces here as a cast.
export const forwarding: FetchLike = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body ?? null,
    redirect: init.redirect ?? 'manual',
    signal: init.signal,
  })

const options: PingClientOptions = {
  baseUrl: 'https://cronheart.com',
  monitors: { 'nightly-backup': '00000000-0000-4000-8000-000000000000' },
  timeoutMs: 2000,
  truncate: 'tail',
  redact: [/token=\S+/g],
  fetch: forwarding,
  onResult: (result: PingResult) => outcomes.push(describePingResult(result)),
}

// What a consumer validating its own configuration needs at load time, and what it needs
// to tell a check-in nobody answered from one the server refused.
export function configured(id: string): boolean {
  return isMonitorId(id)
}

export function reachedTheServer(result: PingResult): boolean {
  return result.sent && result.answered
}

export function emittableActions(): readonly PingAction[] {
  return PING_EMITTABLE_ACTIONS
}

const outcomes: string[] = []

const client: PingClient = createPingClient(options)

export async function exercise(): Promise<string[]> {
  const perCall: PingOptions = { body: 'stderr tail', runtimeMs: 1200 }
  const run: MonitorRun = startRun('nightly-backup')
  const beat: CheckInThunk = checkInWith('nightly-backup', { action: 'success' })

  monitors.define({ sweep: '00000000-0000-4000-8000-000000000001' })
  beat()

  const rows: number = await withMonitor('nightly-backup', () => 12)
  await checkIn('nightly-backup')
  await client.fail('nightly-backup', perCall)
  await run.success()
  await beat.flush()

  return [...outcomes, String(rows)]
}

import {
  CronheartApiError,
  SNOOZE_DURATIONS,
  createCronheartApi,
  isCronheartApiError,
} from 'cronheart/api'
import type {
  Channel,
  CreateChannelRequest,
  CreateMonitorRequest,
  CronheartApi,
  Monitor,
  MonitorPage,
  RateLimitSnapshot,
  SnoozeDuration,
} from 'cronheart/api'

const create: CreateMonitorRequest = {
  name: 'nightly-backup',
  scheduleKind: 'cron',
  scheduleExpr: '0 3 * * *',
  graceSeconds: 300,
  channelIds: ['12', 13],
}

export async function reconcile(apiKey: string | undefined): Promise<string[]> {
  const management: CronheartApi = createCronheartApi({
    apiKey,
    baseUrl: 'https://cronheart.com',
    timeoutMs: 8000,
    retries: 1,
  })
  const first: MonitorPage = await management.monitors.list({ limit: 10 })
  const verified = new Set(
    (await management.channels.list()).data
      .filter((channel: Channel) => channel.verified)
      .map((channel) => channel.id),
  )
  const names: string[] = []

  for await (const monitor of management.monitors.iterate()) {
    names.push(monitor.channels.some((one) => verified.has(one.id)) ? monitor.name : '(silent)')
  }

  try {
    const made: Monitor = await management.monitors.create(create, { idempotencyKey: 'a-key' })
    const nap: SnoozeDuration = SNOOZE_DURATIONS[0]
    await management.monitors.snooze(made.uuid, nap)
  } catch (error) {
    if (isCronheartApiError(error) && error.kind === 'validation') {
      names.push(Object.keys(error.errors).join(','))
    } else if (CronheartApiError.isCronheartApiError(error)) {
      names.push(error.group === 'response' ? `refused ${String(error.status)}` : error.kind)
    }
  }

  const seen: RateLimitSnapshot | undefined = management.rateLimit()

  return [...names, String(first.total), String(seen?.resetAt ?? 'unknown')]
}

// Read one, change one field, write it back — the most ordinary management operation there
// is, and the one a closed write vocabulary against an open read one makes uncompilable.
export async function retune(management: CronheartApi, uuid: string): Promise<string> {
  const current: Monitor = await management.monitors.get(uuid)
  const updated: Monitor = await management.monitors.update(uuid, {
    scheduleKind: current.scheduleKind,
    scheduleExpr: current.scheduleExpr,
    tz: current.tz,
    graceSeconds: current.graceSeconds + 60,
    channelIds: current.channels.map((one) => one.id),
  })

  return `${updated.name} ${updated.scheduleKind}`
}

export function mirrored(channel: Channel): CreateChannelRequest {
  return { kind: channel.kind, label: `${channel.label} (copy)` }
}

// The four scheduler adapters, written the way the README writes them: the peer's own
// entry point, spread or handed the adapter's result. This compiles under the consumer's
// exact flags against the built declarations, which is the only place the peer types and
// ours meet the way a user meets them.
export function scheduleWithCroner(runBackup: () => Promise<number>): Cron {
  return new Cron(
    ...monitoredByCroner('nightly-backup', '0 3 * * *', { timezone: 'Europe/Berlin', protect: true }, runBackup),
  )
}

export function scheduleWithCron(runBackup: () => Promise<void>): CronJob {
  return CronJob.from(
    monitoredByCron('nightly-backup', {
      cronTime: '0 3 * * *',
      timeZone: 'Europe/Berlin',
      waitForCompletion: true,
      onTick: runBackup,
    }),
  )
}

export function scheduleWithNodeSchedule(runBackup: (fireDate: Date) => Promise<number>): Job {
  return scheduleJob(
    ...monitoredBySchedule('nightly-backup', { rule: '0 3 * * *', tz: 'Europe/Berlin' }, runBackup),
  )
}

export function scheduleWithNodeCron(runBackup: () => Promise<void>): MonitoredTask {
  const task: ScheduledTask = nodeCron.schedule('0 3 * * *', runBackup, {
    timezone: 'Europe/Berlin',
    noOverlap: true,
  })

  return monitorNodeCronTask(task, 'nightly-backup')
}

// The queue adapter hands back the worker's own argument list, so the options the monitor
// reads its parallelism from are the ones the worker runs under.
export function workDigestQueue(sendDigest: (job: QueueJob) => Promise<number>): Worker {
  return new Worker(
    ...monitoredByBullMq(
      'digests',
      { connection: { host: '127.0.0.1', port: 6379 }, concurrency: 4 },
      sendDigest,
      { jobs: { 'nightly-digest': 'nightly-backup', 'warm-cache': false } },
    ),
  )
}

// The module form, written the way an application writes it: the framework's own registry
// class goes in as the injection token, because the module imports none of the framework.
export function schedulerModules(): DynamicModule[] {
  return [
    ScheduleModule.forRoot(),
    CronheartModule.forRoot({
      registry: SchedulerRegistry,
      jobs: { nightlyDigest: 'nightly-backup', cleanupTmp: false },
    }),
  ]
}

export function monitorRegistry(registry: SchedulerRegistry): MonitoredSchedule {
  const held: ScheduledJobs = registry

  return monitorScheduledJobs(held, { jobs: { nightlyDigest: 'nightly-backup' } })
}
