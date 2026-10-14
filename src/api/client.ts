import { DEFAULT_BASE_URL } from '../constants.js'
import { attemptsFor } from '../transport/attempts.js'
import { nonNegativeOr, positiveOr } from '../numbers.js'
import { ambientEnv, numberFrom, readEnv } from '../ping/env.js'
import { userAgent } from '../version.js'
import { assertApiBaseUrl, assertApiKey, assertUserAgent } from './config.js'
import {
  API_KEY_VARIABLE,
  API_PAGE_LIMIT_DEFAULT,
  CHANNEL_ADDRESS_KINDS,
  CHANNEL_CHAT_ID_KINDS,
  CHANNEL_ROUTING_KEY_KINDS,
  CHANNEL_SECRET_KINDS,
  CHANNEL_WEBHOOK_URL_KINDS,
  DEFAULT_API_RETRIES,
  DEFAULT_API_TIMEOUT_MS,
} from './constants.js'
import {
  accountFrom,
  alertPageFrom,
  channelFrom,
  channelListFrom,
  channelTestFrom,
  monitorFrom,
  monitorPageFrom,
  pingPageFrom,
  rotatedSecretFrom,
} from './hydrate.js'
import { composed, plainOptions } from './compose.js'
import { type Endpoint, type Session, createSession } from './http.js'
import { ApiConfigurationError, isCronheartApiError } from './errors.js'
import { cursorWalk, offsetWalk } from './paginate.js'
import type {
  Account,
  AccountApi,
  Alert,
  AlertPage,
  Channel,
  ChannelList,
  ChannelTestResult,
  ChannelsApi,
  CreateChannelRequest,
  CreateMonitorRequest,
  CronheartApi,
  CronheartApiOptions,
  CursorOptions,
  ListOptions,
  Monitor,
  MonitorPage,
  MonitorsApi,
  PingPage,
  PingRecord,
  RequestOptions,
  RotatedChannelSecret,
  SnoozeDuration,
  UpdateMonitorRequest,
} from './types.js'
import {
  assertChannelDestination,
  assertChannelKind,
  assertChannelLabel,
  assertGraceSeconds,
  assertMonitorName,
  assertMonitorUuid,
  assertScheduleExprShape,
  assertScheduleExpression,
  assertScheduleKind,
  assertSnoozeDuration,
  canonicalTimezone,
  channelIdFor,
  channelIdsFor,
  pageCursor,
  pageLimit,
  pageOffset,
  refuseMissingChannelField,
} from './validate.js'

const API_KEY_OPTION = 'the apiKey option'

const MONITOR_WIRE_KEYS = {
  name: 'name',
  scheduleKind: 'schedule_kind',
  scheduleExpr: 'schedule_expr',
  tz: 'tz',
  graceSeconds: 'grace_seconds',
  channelIds: 'channel_ids',
} as const

const MONITOR_FIELDS: readonly string[] = [
  ...Object.values(MONITOR_WIRE_KEYS),
  'duration',
  'confirm',
  'limit',
  'offset',
  'cursor',
]

function monitorBodyFrom(request: CreateMonitorRequest | UpdateMonitorRequest, partial: boolean) {
  const { name, scheduleKind, scheduleExpr, tz, graceSeconds, channelIds } = request
  const body: Record<string, unknown> = {}

  if (!partial || name !== undefined) {
    assertMonitorName(name)
    body[MONITOR_WIRE_KEYS.name] = name
  }

  if (!partial || scheduleKind !== undefined) {
    assertScheduleKind(scheduleKind)
    body[MONITOR_WIRE_KEYS.scheduleKind] = scheduleKind
  }

  if (!partial || scheduleExpr !== undefined) {
    // The dialect check needs the kind, and an update that changes only the expression is
    // merged over a stored kind this client cannot see. Shape is all that can be checked.
    if (scheduleKind === undefined) {
      assertScheduleExprShape(scheduleExpr)
    } else {
      assertScheduleExpression(scheduleKind, scheduleExpr)
    }

    body[MONITOR_WIRE_KEYS.scheduleExpr] = scheduleExpr
  }

  if (tz !== undefined) {
    body[MONITOR_WIRE_KEYS.tz] = canonicalTimezone(tz)
  }

  if (graceSeconds !== undefined) {
    assertGraceSeconds(graceSeconds)
    body[MONITOR_WIRE_KEYS.graceSeconds] = graceSeconds
  }

  if (channelIds !== undefined) {
    // Written as the decimal string the listing reports, which the service casts to an
    // integer. Sending a JavaScript number instead would round a 64-bit identifier.
    body[MONITOR_WIRE_KEYS.channelIds] = channelIdsFor(channelIds)
  }

  return body
}

const CHANNEL_DESTINATIONS = [
  ['address', 'address', CHANNEL_ADDRESS_KINDS],
  ['chat_id', 'chatId', CHANNEL_CHAT_ID_KINDS],
  ['webhook_url', 'webhookUrl', CHANNEL_WEBHOOK_URL_KINDS],
  ['secret', 'secret', CHANNEL_SECRET_KINDS],
  ['routing_key', 'routingKey', CHANNEL_ROUTING_KEY_KINDS],
] as const

const CHANNEL_FIELDS: readonly string[] = ['kind', 'label', ...CHANNEL_DESTINATIONS.map(([key]) => key)]

function channelBodyFrom(request: CreateChannelRequest) {
  const { kind, label, address, chatId, webhookUrl, secret, routingKey } = request
  const given = { address, chatId, webhookUrl, secret, routingKey }

  assertChannelKind(kind)
  assertChannelLabel(label)

  const body: Record<string, unknown> = { kind, label }

  for (const [key, field, neededBy] of CHANNEL_DESTINATIONS) {
    const value = given[field]

    if (value === undefined) {
      if ((neededBy as readonly string[]).includes(kind)) {
        refuseMissingChannelField(field, kind)
      }

      continue
    }

    assertChannelDestination(value, field)
    body[key] = value
  }

  return body
}

function channelRoute(endpoint: () => Endpoint): () => Endpoint {
  return () => ({ ...endpoint(), problemFieldsKept: CHANNEL_FIELDS })
}

function monitorRoute(endpoint: () => Endpoint): () => Endpoint {
  return () => ({ ...endpoint(), problemFieldsKept: MONITOR_FIELDS })
}

// A property is an accessor as readily as a value, and one that throws would leave this
// rejecting with something no caller of it is catching.
export function createCronheartApi(configuration: CronheartApiOptions = {}): CronheartApi {
  try {
    return build(configuration)
  } catch (error) {
    throw isCronheartApiError(error)
      ? error
      : new ApiConfigurationError(
          'cronheart: the options passed to createCronheartApi could not be read.',
        )
  }
}

function build(configuration: CronheartApiOptions): CronheartApi {
  const env = configuration.env ?? ambientEnv()
  const apiKey = configuration.apiKey ?? readEnv(env, 'API_KEY')
  const configuredUrl = configuration.baseUrl ?? readEnv(env, 'URL') ?? DEFAULT_BASE_URL
  const agent = configuration.userAgent ?? userAgent()

  assertApiKey(apiKey, configuration.apiKey === undefined ? API_KEY_VARIABLE : API_KEY_OPTION)
  assertApiBaseUrl(configuredUrl)
  assertUserAgent(agent)

  const session: Session = createSession({
    baseUrl: configuredUrl.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: positiveOr(
      configuration.timeoutMs ?? numberFrom(env, 'TIMEOUT_MS'),
      DEFAULT_API_TIMEOUT_MS,
    ),
    attempts: attemptsFor(
      nonNegativeOr(configuration.retries ?? numberFrom(env, 'RETRIES'), DEFAULT_API_RETRIES),
    ),
    userAgent: agent,
    fetch: configuration.fetch,
    signal: configuration.signal,
  })

  function send(endpoint: () => Endpoint, options: RequestOptions | undefined): Promise<unknown> {
    const request = composed(() => ({ endpoint: endpoint(), options: plainOptions(options) }))

    return session.send(request.endpoint, request.options)
  }

  async function read<T>(
    endpoint: () => Endpoint,
    options: RequestOptions | undefined,
    hydrate: (value: unknown) => T,
  ): Promise<T> {
    return hydrate(await send(endpoint, options))
  }

  function monitorAt(uuid: string, suffix = ''): string {
    assertMonitorUuid(uuid)

    return `/monitors/${uuid}${suffix}`
  }

  function channelAt(id: string | number, suffix = ''): string {
    return `/channels/${channelIdFor(id)}${suffix}`
  }

  function monitorAction(
    uuid: string,
    action: string,
    options: RequestOptions | undefined,
    body?: unknown,
  ) {
    return read<Monitor>(
      monitorRoute(() => ({
        method: 'POST',
        path: monitorAt(uuid, `/${action}`),
        // A rotate leaves a different identifier behind every time it runs, so a repeat is
        // a second rotation and the first one's new address is lost before anyone read it.
        retry: action === 'rotate-uuid' ? 'never' : 'safe',
        body,
      })),
      options,
      monitorFrom,
    )
  }

  function monitorPage(options: ListOptions | undefined): Promise<MonitorPage> {
    return read(
      () => ({
        method: 'GET',
        path: '/monitors',
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          offset: pageOffset(options?.offset),
        },
      }),
      options,
      monitorPageFrom,
    )
  }

  function alertPage(uuid: string, options: ListOptions | undefined): Promise<AlertPage> {
    return read(
      monitorRoute(() => ({
        method: 'GET',
        path: monitorAt(uuid, '/alerts'),
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          offset: pageOffset(options?.offset),
        },
      })),
      options,
      alertPageFrom,
    )
  }

  function pingPage(uuid: string, options: CursorOptions | undefined): Promise<PingPage> {
    return read(
      monitorRoute(() => ({
        method: 'GET',
        path: monitorAt(uuid, '/pings'),
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          cursor: pageCursor(options?.cursor),
        },
      })),
      options,
      pingPageFrom,
    )
  }

  // Every method below is async, and every iterator is a generator, so that a request this
  // client refuses to compose arrives as a rejection rather than as a synchronous throw out
  // of something whose signature promises a promise — which no await or catch would see.
  function offsetWalkOptions(options: ListOptions | undefined) {
    return composed(() => ({
      ...plainOptions(options),
      limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
      offset: pageOffset(options?.offset),
    }))
  }

  async function* walkMonitors(options: ListOptions | undefined) {
    const { limit, offset, ...plain } = offsetWalkOptions(options)

    yield* offsetWalk<Monitor>(
      'monitors',
      (monitor) => monitor.uuid,
      (size, from) => monitorPage({ ...plain, limit: size, offset: from }),
      limit,
      offset,
    )
  }

  async function* walkAlerts(uuid: string, options: ListOptions | undefined) {
    const { limit, offset, ...plain } = offsetWalkOptions(options)

    yield* offsetWalk<Alert>(
      'alerts',
      (alert) => alert.id,
      (size, from) => alertPage(uuid, { ...plain, limit: size, offset: from }),
      limit,
      offset,
    )
  }

  async function* walkPings(uuid: string, options: CursorOptions | undefined) {
    const { limit, cursor, ...plain } = composed(() => ({
      ...plainOptions(options),
      limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
      cursor: pageCursor(options?.cursor),
    }))

    yield* cursorWalk<PingRecord>(
      'pings',
      (size, from) => pingPage(uuid, { ...plain, limit: size, cursor: from }),
      limit,
      cursor,
    )
  }

  const monitors: MonitorsApi = {
    list: async (options) => monitorPage(options),
    iterate: (options) => walkMonitors(options),
    get: async (uuid, options) =>
      read(monitorRoute(() => ({ method: 'GET', path: monitorAt(uuid), retry: 'safe' })), options, monitorFrom),
    create: async (request, options) =>
      read(
        () => ({
          method: 'POST',
          path: '/monitors',
          retry: 'with-idempotency-key',
          body: monitorBodyFrom(request, false),
          idempotencyKey: options?.idempotencyKey,
        }),
        options,
        monitorFrom,
      ),
    update: async (uuid, request, options) =>
      read(
        monitorRoute(() => ({
          method: 'PATCH',
          path: monitorAt(uuid),
          retry: 'safe',
          body: monitorBodyFrom(request, true),
        })),
        options,
        monitorFrom,
      ),
    delete: async (uuid, options) => {
      await send(monitorRoute(() => ({ method: 'DELETE', path: monitorAt(uuid), retry: 'safe' })), options)
    },
    pause: async (uuid, options) => monitorAction(uuid, 'pause', options),
    resume: async (uuid, options) => monitorAction(uuid, 'resume', options),
    snooze: async (uuid, duration: SnoozeDuration, options) => {
      assertSnoozeDuration(duration)

      return monitorAction(uuid, 'snooze', options, { duration })
    },
    unsnooze: async (uuid, options) => monitorAction(uuid, 'unsnooze', options),
    // The confirmation the service asks for is the identifier the caller already named, so
    // it is filled in here: a second copy of the same string proves nothing to anyone.
    rotateUuid: async (uuid, options) =>
      monitorAction(uuid, 'rotate-uuid', options, { confirm: uuid }),
    pings: async (uuid, options) => pingPage(uuid, options),
    iteratePings: (uuid, options) => walkPings(uuid, options),
    alerts: async (uuid, options) => alertPage(uuid, options),
    iterateAlerts: (uuid, options) => walkAlerts(uuid, options),
  }

  const channels: ChannelsApi = {
    // Deliberately not an iterator and deliberately not paged: the listing reads no
    // pagination parameters and echoes none back, so a generic offset walk pointed at it
    // could not even tell one request's worth from the whole set, and would never finish.
    list: async (options) =>
      read<ChannelList>(
        channelRoute(() => ({ method: 'GET', path: '/channels', retry: 'safe' })),
        options,
        channelListFrom,
      ),
    get: async (id, options) =>
      read<Channel>(
        channelRoute(() => ({ method: 'GET', path: channelAt(id), retry: 'safe' })),
        options,
        channelFrom,
      ),
    create: async (request, options) =>
      read<Channel>(
        channelRoute(() => ({
          method: 'POST',
          path: '/channels',
          retry: 'with-idempotency-key',
          body: channelBodyFrom(request),
          idempotencyKey: options?.idempotencyKey,
          // An email channel spends a verification-mail allowance of its own.
          separatelyThrottled: true,
        })),
        options,
        channelFrom,
      ),
    rename: async (id, label, options) => {
      assertChannelLabel(label)

      return read<Channel>(
        channelRoute(() => ({ method: 'PATCH', path: channelAt(id), retry: 'safe', body: { label } })),
        options,
        channelFrom,
      )
    },
    delete: async (id, options) => {
      await send(channelRoute(() => ({ method: 'DELETE', path: channelAt(id), retry: 'safe' })), options)
    },
    rotateSecret: async (id, options) =>
      read<RotatedChannelSecret>(
        channelRoute(() => ({ method: 'POST', path: channelAt(id, '/rotate-secret'), retry: 'never' })),
        options,
        rotatedSecretFrom,
      ),
    // Never retried: it delivers a real message and spends a burst allowance that is not
    // the account's API rate limit, so a repeat is a second notification, not a retry.
    test: async (id, options) =>
      read<ChannelTestResult>(
        channelRoute(() => ({
          method: 'POST',
          path: channelAt(id, '/test'),
          retry: 'never',
          deliversDownstream: true,
          separatelyThrottled: true,
        })),
        options,
        channelTestFrom,
      ),
  }

  const account: AccountApi = {
    get: async (options) =>
      read<Account>(() => ({ method: 'GET', path: '/account', retry: 'safe' }), options, accountFrom),
  }

  // A function rather than an accessor: every other member of this object survives being
  // destructured off it, which is the whole reason the client is a factory.
  return { monitors, channels, account, rateLimit: () => session.rateLimit }
}
