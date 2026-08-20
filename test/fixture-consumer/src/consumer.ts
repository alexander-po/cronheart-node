import {
  PING_BODY_CAP_BYTES,
  SDK_VERSION,
  checkIn,
  checkInWith,
  createPingClient,
  monitors,
  startRun,
  userAgent,
  withMonitor,
} from 'cronheart'
import type {
  CheckInThunk,
  FetchLike,
  MonitorRun,
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
  onResult: (result: PingResult) => outcomes.push(result.outcome),
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

  const seen: RateLimitSnapshot | undefined = management.rateLimit

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
