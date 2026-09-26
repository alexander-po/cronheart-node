import { isApiKeyShaped } from './config.js'
import { API_TOKEN_PREFIX, SIGNUP_USER_CODE_PATTERN } from './constants.js'
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
  OpenIncident,
  PingPage,
  PingRecord,
  RotatedChannelSecret,
  SignupPollResult,
  SignupStarted,
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

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    refuse(what, `has no whole-number ${key}`)
  }

  return value
}

function optionalInteger(source: Source, key: string, what: string): number | null {
  const value = source[key]

  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    refuse(what, `has a ${key} that is neither a whole number nor null`)
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

function openIncidentFrom(value: unknown): OpenIncident | null {
  if (value === null || value === undefined) {
    return null
  }

  const source = objectFrom(value, 'monitor open incident')

  return {
    kind: text(source, 'kind', 'monitor open incident'),
    since: optionalText(source, 'since', 'monitor open incident'),
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
    openIncident: openIncidentFrom(source['open_incident']),
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

// Printed on a terminal, so anything outside the published shape is refused, never shown.
const USER_CODE = new RegExp(SIGNUP_USER_CODE_PATTERN)

const PRINTABLE = /^[ -~]+$/

const LONGEST_LABEL = 80

const LONGEST_HINT = 500

const LONGEST_SHOWN_PREFIX = API_TOKEN_PREFIX.length + 8

function wholeSeconds(source: Source, key: string, what: string): number {
  const value = integer(source, key, what)

  if (value < 0) {
    refuse(what, `has a negative ${key}`)
  }

  return value
}

export function signupStartedFrom(value: unknown): SignupStarted {
  const what = 'signup answer'
  const source = objectFrom(value, what)
  const deviceCode = text(source, 'device_code', what)
  const userCode = text(source, 'user_code', what)

  if (deviceCode === '') {
    refuse(what, 'has an empty device_code')
  }

  if (!USER_CODE.test(userCode)) {
    refuse(what, 'has a user_code that is not two groups of four capital consonants')
  }

  return {
    deviceCode,
    userCode,
    expiresIn: wholeSeconds(source, 'expires_in', what),
    interval: wholeSeconds(source, 'interval', what),
    hint: displayable(source, 'hint', LONGEST_HINT),
  }
}

function displayable(source: Source, key: string, longest: number): string | null {
  const value = source[key]

  return typeof value === 'string' && value.length <= longest && PRINTABLE.test(value) ? value : null
}

function shownPrefix(source: Source, token: string): string | null {
  const prefix = displayable(source, 'token_prefix', LONGEST_SHOWN_PREFIX)

  return prefix !== null && token.startsWith(prefix) ? prefix : null
}

// The status decides, and only the token must be there, since it is never sent again.
export function signupPollFrom(status: number, value: unknown): SignupPollResult {
  const what = 'signup poll answer'
  const source = objectFrom(value, what)

  if (status === 202) {
    return { status: 'pending' }
  }

  if (status !== 200) {
    refuse(what, `came with HTTP ${status}, which is neither pending nor issued`)
  }

  const token = text(source, 'token', what)

  if (!isApiKeyShaped(token)) {
    refuse(what, 'has a token that is not an API key of this service')
  }

  return {
    status: 'issued',
    token,
    tokenPrefix: shownPrefix(source, token),
    project: displayable(source, 'project', LONGEST_LABEL),
  }
}
