import type { AbortSignalLike, FetchLike } from '../ping/types.js'
import type {
  CHANNEL_KINDS,
  MONITOR_STATUSES,
  PLAN_KEYS,
  SCHEDULE_KINDS,
  SIMPLE_SCHEDULES,
  SNOOZE_DURATIONS,
} from './constants.js'

export type { AbortSignalLike, FetchLike }

// Read vocabularies are open: the service may add a member before this package is updated,
// and a reader that rejected one would turn a server-side addition into a client outage.
export type Open<T extends string> = T | (string & {})

export type MonitorStatus = (typeof MONITOR_STATUSES)[number]

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export type SimpleSchedule = (typeof SIMPLE_SCHEDULES)[number]

export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export type SnoozeDuration = (typeof SNOOZE_DURATIONS)[number]

export type PlanKey = (typeof PLAN_KEYS)[number]

export type PingKind = 'heartbeat' | 'start' | 'success' | 'fail'

export type AlertKind = 'late' | 'fail' | 'recovered'

export interface MonitorChannelRef {
  readonly id: string
  readonly kind: Open<ChannelKind>
  readonly label: string
}

export interface Monitor {
  readonly uuid: string
  readonly name: string
  readonly scheduleKind: Open<ScheduleKind>
  readonly scheduleExpr: string
  readonly tz: string
  readonly graceSeconds: number
  // Attachment, not deliverability: an attached channel that is not verified is skipped at
  // send time, and this projection carries no verified flag. Intersect with channels.list()
  // to answer whether a monitor alerts anybody.
  readonly channels: readonly MonitorChannelRef[]
  readonly status: Open<MonitorStatus>
  readonly nextExpectedAt: string | null
  readonly snoozedUntil: string | null
  readonly lastPingAt: string | null
  readonly createdAt: string
  readonly pingUrl: string
  readonly badgeUrl: string
}

export interface Channel {
  readonly id: string
  readonly kind: Open<ChannelKind>
  readonly label: string
  readonly verified: boolean
  // The destination keys are masked when set, so a Slack or Discord address can be replaced
  // but never read back or compared.
  readonly config: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

export interface PingRecord {
  readonly id: string
  readonly kind: Open<PingKind>
  readonly receivedAt: string
  readonly runtimeMs: number | null
}

export interface Alert {
  readonly id: string
  readonly kind: Open<AlertKind>
  readonly createdAt: string
  readonly dispatchedTo: Readonly<Record<string, string>> | null
}

export interface Plan {
  readonly key: Open<PlanKey>
  readonly label: string
  readonly monitorLimit: number
}

export interface MonitorBudget {
  readonly used: number
  readonly limit: number
  readonly remaining: number
}

export interface AccountRateLimit {
  readonly limit: number
  readonly remaining: number
}

export interface Account {
  readonly plan: Plan
  readonly monitorBudget: MonitorBudget
  readonly apiRateLimit: AccountRateLimit
}

export interface OffsetPage<T> {
  readonly data: readonly T[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

export type MonitorPage = OffsetPage<Monitor>

export type AlertPage = OffsetPage<Alert>

export interface PingPage {
  readonly data: readonly PingRecord[]
  readonly nextCursor: string | null
}

// Not a page and not an iterator: the channels listing reads no pagination parameters and
// echoes none back, so a client cannot even tell one request's worth from the whole set.
export interface ChannelList {
  readonly data: readonly Channel[]
  readonly total: number
}

export interface ChannelTestResult {
  readonly delivered: boolean
  readonly channel: Channel
  readonly newlyVerified: boolean
}

export interface RotatedChannelSecret {
  readonly channel: Channel
  // Returned in the clear once, on this response only.
  readonly secret: string
}

export interface RateLimitSnapshot {
  readonly limit: number | undefined
  readonly remaining: number | undefined
  // A Unix timestamp in seconds, not a delta.
  readonly resetAt: number | undefined
}

export interface ProblemDetails {
  readonly status: number | undefined
  readonly title: string | undefined
  // The service publishes no machine-readable code, and this string is a translation key on
  // one status and product prose on another. Never branch on it and never show it to a user.
  readonly detail: string | undefined
  readonly errors: Readonly<Record<string, string>> | undefined
  readonly upgradeUrl: string | undefined
  readonly retryAfterSeconds: number | undefined
}

export interface RequestOptions {
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignalLike | undefined
}

export interface CreateOptions extends RequestOptions {
  // Without one a create is never retried, because a retried create that the service did
  // receive would make a second monitor.
  readonly idempotencyKey?: string | undefined
}

export interface ListParams {
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

export interface CursorParams {
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

export type ListOptions = ListParams & RequestOptions

export type CursorOptions = CursorParams & RequestOptions

export interface CreateMonitorRequest {
  readonly name: string
  readonly scheduleKind: ScheduleKind
  readonly scheduleExpr: string
  readonly tz?: string | undefined
  readonly graceSeconds?: number | undefined
  readonly channelIds?: readonly (string | number)[] | undefined
}

export interface UpdateMonitorRequest {
  readonly name?: string | undefined
  readonly scheduleKind?: ScheduleKind | undefined
  readonly scheduleExpr?: string | undefined
  readonly tz?: string | undefined
  readonly graceSeconds?: number | undefined
  // Present, even empty, replaces the routing wholesale; absent keeps it.
  readonly channelIds?: readonly (string | number)[] | undefined
}

export interface CreateChannelRequest {
  readonly kind: ChannelKind
  readonly label: string
  readonly address?: string | undefined
  readonly chatId?: string | undefined
  readonly webhookUrl?: string | undefined
  readonly secret?: string | undefined
}

export interface CronheartApiOptions {
  readonly apiKey?: string | undefined
  readonly baseUrl?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly retries?: number | undefined
  readonly fetch?: FetchLike | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignalLike | undefined
  readonly userAgent?: string | undefined
}

export interface MonitorsApi {
  list(options?: ListOptions): Promise<MonitorPage>
  iterate(options?: ListOptions): AsyncIterableIterator<Monitor>
  get(uuid: string, options?: RequestOptions): Promise<Monitor>
  create(request: CreateMonitorRequest, options?: CreateOptions): Promise<Monitor>
  update(uuid: string, request: UpdateMonitorRequest, options?: RequestOptions): Promise<Monitor>
  delete(uuid: string, options?: RequestOptions): Promise<void>
  pause(uuid: string, options?: RequestOptions): Promise<Monitor>
  resume(uuid: string, options?: RequestOptions): Promise<Monitor>
  snooze(uuid: string, duration: SnoozeDuration, options?: RequestOptions): Promise<Monitor>
  unsnooze(uuid: string, options?: RequestOptions): Promise<Monitor>
  rotateUuid(uuid: string, options?: RequestOptions): Promise<Monitor>
  pings(uuid: string, options?: CursorOptions): Promise<PingPage>
  iteratePings(uuid: string, options?: CursorOptions): AsyncIterableIterator<PingRecord>
  alerts(uuid: string, options?: ListOptions): Promise<AlertPage>
  iterateAlerts(uuid: string, options?: ListOptions): AsyncIterableIterator<Alert>
}

export interface ChannelsApi {
  list(options?: RequestOptions): Promise<ChannelList>
  get(id: string | number, options?: RequestOptions): Promise<Channel>
  create(request: CreateChannelRequest, options?: CreateOptions): Promise<Channel>
  rename(id: string | number, label: string, options?: RequestOptions): Promise<Channel>
  delete(id: string | number, options?: RequestOptions): Promise<void>
  rotateSecret(id: string | number, options?: RequestOptions): Promise<RotatedChannelSecret>
  test(id: string | number, options?: RequestOptions): Promise<ChannelTestResult>
}

export interface AccountApi {
  get(options?: RequestOptions): Promise<Account>
}

export interface CronheartApi {
  readonly monitors: MonitorsApi
  readonly channels: ChannelsApi
  readonly account: AccountApi
  // What the most recent answered request reported. Absent until one has been, and stale
  // rather than missing after a status the service omits the headers from.
  readonly rateLimit: RateLimitSnapshot | undefined
}
