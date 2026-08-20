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

const options: PingClientOptions = {
  baseUrl: 'https://cronheart.com',
  monitors: { 'nightly-backup': '00000000-0000-4000-8000-000000000000' },
  timeoutMs: 2000,
  truncate: 'tail',
  redact: [/token=\S+/g],
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
