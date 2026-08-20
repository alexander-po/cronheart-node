import { ApiHydrationError } from './errors.js'
import type {
  Account,
  Alert,
  AlertPage,
  Channel,
  ChannelList,
  ChannelTestResult,
  Monitor,
  MonitorChannelRef,
  MonitorPage,
  PingPage,
  PingRecord,
  RotatedChannelSecret,
} from './types.js'

type Source = Readonly<Record<string, unknown>>

function refuse(what: string, why: string): never {
  throw new ApiHydrationError(`The service's ${what} ${why}. This client cannot read it.`)
}

export function objectFrom(value: unknown, what: string): Source {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(what, 'is not an object')
  }

  return value as Source
}

function text(source: Source, key: string, what: string): string {
  const value = source[key]

  if (typeof value !== 'string') {
    refuse(what, `has no string ${key}`)
  }

  return value
}

function optionalText(source: Source, key: string, what: string): string | null {
  const value = source[key]

  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'string') {
    refuse(what, `has a ${key} that is neither a string nor null`)
  }

  return value
}

function integer(source: Source, key: string, what: string): number {
  const value = source[key]

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(what, `has no numeric ${key}`)
  }

  return value
}

function optionalInteger(source: Source, key: string, what: string): number | null {
  const value = source[key]

  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(what, `has a ${key} that is neither a number nor null`)
  }

  return value
}

function flag(source: Source, key: string, what: string): boolean {
  const value = source[key]

  if (typeof value !== 'boolean') {
    refuse(what, `has no boolean ${key}`)
  }

  return value
}

function list(source: Source, key: string, what: string): readonly unknown[] {
  const value = source[key]

  if (!Array.isArray(value)) {
    refuse(what, `has no ${key} array`)
  }

  return value
}

function mapping(source: Source, key: string, what: string): Readonly<Record<string, string>> | null {
  const value = source[key]

  if (value === null || value === undefined) {
    return null
  }

  const entries = objectFrom(value, `${what} ${key}`)
  const collected: Record<string, string> = {}

  for (const [name, at] of Object.entries(entries)) {
    if (typeof at === 'string') {
      collected[name] = at
    }
  }

  return collected
}

function monitorChannelFrom(value: unknown): MonitorChannelRef {
  const source = objectFrom(value, 'monitor channel')

  return {
    id: text(source, 'id', 'monitor channel'),
    kind: text(source, 'kind', 'monitor channel'),
    label: text(source, 'label', 'monitor channel'),
  }
}

export function monitorFrom(value: unknown): Monitor {
  const source = objectFrom(value, 'monitor')

  return {
    uuid: text(source, 'uuid', 'monitor'),
    name: text(source, 'name', 'monitor'),
    scheduleKind: text(source, 'schedule_kind', 'monitor'),
    scheduleExpr: text(source, 'schedule_expr', 'monitor'),
    tz: text(source, 'tz', 'monitor'),
    graceSeconds: integer(source, 'grace_seconds', 'monitor'),
    channels: list(source, 'channels', 'monitor').map(monitorChannelFrom),
    status: text(source, 'status', 'monitor'),
    nextExpectedAt: optionalText(source, 'next_expected_at', 'monitor'),
    snoozedUntil: optionalText(source, 'snoozed_until', 'monitor'),
    lastPingAt: optionalText(source, 'last_ping_at', 'monitor'),
    createdAt: text(source, 'created_at', 'monitor'),
    pingUrl: text(source, 'ping_url', 'monitor'),
    badgeUrl: text(source, 'badge_url', 'monitor'),
  }
}

export function channelFrom(value: unknown): Channel {
  const source = objectFrom(value, 'channel')

  return {
    id: text(source, 'id', 'channel'),
    kind: text(source, 'kind', 'channel'),
    label: text(source, 'label', 'channel'),
    verified: flag(source, 'verified', 'channel'),
    config: objectFrom(source['config'], 'channel config'),
    createdAt: text(source, 'created_at', 'channel'),
  }
}

export function pingFrom(value: unknown): PingRecord {
  const source = objectFrom(value, 'ping')

  return {
    id: text(source, 'id', 'ping'),
    kind: text(source, 'kind', 'ping'),
    receivedAt: text(source, 'received_at', 'ping'),
    runtimeMs: optionalInteger(source, 'runtime_ms', 'ping'),
  }
}

export function alertFrom(value: unknown): Alert {
  const source = objectFrom(value, 'alert')

  return {
    id: text(source, 'id', 'alert'),
    kind: text(source, 'kind', 'alert'),
    createdAt: text(source, 'created_at', 'alert'),
    dispatchedTo: mapping(source, 'dispatched_to', 'alert'),
  }
}

export function accountFrom(value: unknown): Account {
  const source = objectFrom(value, 'account')
  const plan = objectFrom(source['plan'], 'account plan')
  const budget = objectFrom(source['monitor_budget'], 'account monitor budget')
  const limit = objectFrom(source['api_rate_limit'], 'account rate limit')

  return {
    plan: {
      key: text(plan, 'key', 'account plan'),
      label: text(plan, 'label', 'account plan'),
      monitorLimit: integer(plan, 'monitor_limit', 'account plan'),
    },
    monitorBudget: {
      used: integer(budget, 'used', 'account monitor budget'),
      limit: integer(budget, 'limit', 'account monitor budget'),
      remaining: integer(budget, 'remaining', 'account monitor budget'),
    },
    apiRateLimit: {
      limit: integer(limit, 'limit', 'account rate limit'),
      remaining: integer(limit, 'remaining', 'account rate limit'),
    },
  }
}

function offsetPage<T>(value: unknown, what: string, item: (entry: unknown) => T) {
  const source = objectFrom(value, what)

  return {
    data: list(source, 'data', what).map(item),
    total: integer(source, 'total', what),
    limit: integer(source, 'limit', what),
    offset: integer(source, 'offset', what),
  }
}

export function monitorPageFrom(value: unknown): MonitorPage {
  return offsetPage(value, 'monitor listing', monitorFrom)
}

export function alertPageFrom(value: unknown): AlertPage {
  return offsetPage(value, 'alert listing', alertFrom)
}

export function pingPageFrom(value: unknown): PingPage {
  const source = objectFrom(value, 'ping listing')

  return {
    data: list(source, 'data', 'ping listing').map(pingFrom),
    nextCursor: optionalText(source, 'next_cursor', 'ping listing'),
  }
}

export function channelListFrom(value: unknown): ChannelList {
  const source = objectFrom(value, 'channel listing')

  return {
    data: list(source, 'data', 'channel listing').map(channelFrom),
    total: integer(source, 'total', 'channel listing'),
  }
}

export function channelTestFrom(value: unknown): ChannelTestResult {
  const source = objectFrom(value, 'channel test result')

  return {
    delivered: flag(source, 'delivered', 'channel test result'),
    channel: channelFrom(source['channel']),
    newlyVerified: flag(source, 'newly_verified', 'channel test result'),
  }
}

export function rotatedSecretFrom(value: unknown): RotatedChannelSecret {
  const source = objectFrom(value, 'rotated channel secret')

  return {
    channel: channelFrom(source),
    secret: text(source, 'secret', 'rotated channel secret'),
  }
}
