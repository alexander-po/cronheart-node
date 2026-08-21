import { DEFAULT_BASE_URL } from '../constants.js'
import { attemptsFor } from '../transport/attempts.js'
import { nonNegativeOr, positiveOr } from '../numbers.js'
import { ambientEnv, numberFrom, readEnv } from '../ping/env.js'
import { userAgent } from '../version.js'
import { assertApiBaseUrl, assertApiKey, assertUserAgent } from './config.js'
import {
  API_PAGE_LIMIT_DEFAULT,
  CHANNEL_ADDRESS_KINDS,
  CHANNEL_CHAT_ID_KINDS,
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
  pageLimit,
  pageOffset,
  refuseMissingChannelField,
} from './validate.js'

const API_KEY_VARIABLE = 'CRONHEART_API_KEY'

const API_KEY_OPTION = 'the apiKey option'

function monitorBodyFrom(request: CreateMonitorRequest | UpdateMonitorRequest, partial: boolean) {
  const body: Record<string, unknown> = {}

  if (!partial || request.name !== undefined) {
    assertMonitorName(request.name)
    body['name'] = request.name
  }

  if (!partial || request.scheduleKind !== undefined) {
    assertScheduleKind(request.scheduleKind)
    body['schedule_kind'] = request.scheduleKind
  }

  if (!partial || request.scheduleExpr !== undefined) {
    // The dialect check needs the kind, and an update that changes only the expression is
    // merged over a stored kind this client cannot see. Shape is all that can be checked.
    if (request.scheduleKind === undefined) {
      assertScheduleExprShape(request.scheduleExpr)
    } else {
      assertScheduleExpression(request.scheduleKind, request.scheduleExpr)
    }

    body['schedule_expr'] = request.scheduleExpr
  }

  if (request.tz !== undefined) {
    body['tz'] = canonicalTimezone(request.tz)
  }

  if (request.graceSeconds !== undefined) {
    assertGraceSeconds(request.graceSeconds)
    body['grace_seconds'] = request.graceSeconds
  }

  if (request.channelIds !== undefined) {
    // Written as the decimal string the listing reports, which the service casts to an
    // integer. Sending a JavaScript number instead would round a 64-bit identifier.
    body['channel_ids'] = channelIdsFor(request.channelIds)
  }

  return body
}

function channelBodyFrom(request: CreateChannelRequest) {
  assertChannelKind(request.kind)
  assertChannelLabel(request.label)

  const body: Record<string, unknown> = { kind: request.kind, label: request.label }

  for (const [key, field, value, neededBy] of [
    ['address', 'address', request.address, CHANNEL_ADDRESS_KINDS],
    ['chat_id', 'chatId', request.chatId, CHANNEL_CHAT_ID_KINDS],
    ['webhook_url', 'webhookUrl', request.webhookUrl, CHANNEL_WEBHOOK_URL_KINDS],
    ['secret', 'secret', request.secret, CHANNEL_SECRET_KINDS],
  ] as const) {
    if (value === undefined) {
      if ((neededBy as readonly string[]).includes(request.kind)) {
        refuseMissingChannelField(field, request.kind)
      }

      continue
    }

    assertChannelDestination(value, field)
    body[key] = value
  }

  return body
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

  async function read<T>(
    endpoint: Endpoint,
    options: RequestOptions | undefined,
    hydrate: (value: unknown) => T,
  ): Promise<T> {
    return hydrate(await session.send(endpoint, options))
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
      {
        method: 'POST',
        path: monitorAt(uuid, `/${action}`),
        // A rotate leaves a different identifier behind every time it runs, so a repeat is
        // a second rotation and the first one's new address is lost before anyone read it.
        retry: action === 'rotate-uuid' ? 'never' : 'safe',
        body,
      },
      options,
      monitorFrom,
    )
  }

  function monitorPage(options: ListOptions | undefined): Promise<MonitorPage> {
    return read(
      {
        method: 'GET',
        path: '/monitors',
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          offset: pageOffset(options?.offset),
        },
      },
      options,
      monitorPageFrom,
    )
  }

  function alertPage(uuid: string, options: ListOptions | undefined): Promise<AlertPage> {
    return read(
      {
        method: 'GET',
        path: monitorAt(uuid, '/alerts'),
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          offset: pageOffset(options?.offset),
        },
      },
      options,
      alertPageFrom,
    )
  }

  function pingPage(uuid: string, options: CursorOptions | undefined): Promise<PingPage> {
    return read(
      {
        method: 'GET',
        path: monitorAt(uuid, '/pings'),
        retry: 'safe',
        query: {
          limit: pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
          cursor: options?.cursor,
        },
      },
      options,
      pingPageFrom,
    )
  }

  // Every method below is async, and every iterator is a generator, so that a request this
  // client refuses to compose arrives as a rejection rather than as a synchronous throw out
  // of something whose signature promises a promise — which no await or catch would see.
  async function* walkMonitors(options: ListOptions | undefined) {
    yield* offsetWalk<Monitor>(
      'monitors',
      (monitor) => monitor.uuid,
      (limit, offset) => monitorPage({ ...options, limit, offset }),
      pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
      pageOffset(options?.offset),
    )
  }

  async function* walkAlerts(uuid: string, options: ListOptions | undefined) {
    yield* offsetWalk<Alert>(
      'alerts',
      (alert) => alert.id,
      (limit, offset) => alertPage(uuid, { ...options, limit, offset }),
      pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
      pageOffset(options?.offset),
    )
  }

  async function* walkPings(uuid: string, options: CursorOptions | undefined) {
    yield* cursorWalk<PingRecord>(
      'pings',
      (limit, cursor) => pingPage(uuid, { ...options, limit, cursor }),
      pageLimit(options?.limit, API_PAGE_LIMIT_DEFAULT),
      options?.cursor,
    )
  }

  const monitors: MonitorsApi = {
    list: async (options) => monitorPage(options),
    iterate: (options) => walkMonitors(options),
    get: async (uuid, options) =>
      read({ method: 'GET', path: monitorAt(uuid), retry: 'safe' }, options, monitorFrom),
    create: async (request, options) =>
      read(
        {
          method: 'POST',
          path: '/monitors',
          retry: 'with-idempotency-key',
          body: monitorBodyFrom(request, false),
          idempotencyKey: options?.idempotencyKey,
        },
        options,
        monitorFrom,
      ),
    update: async (uuid, request, options) =>
      read(
        {
          method: 'PATCH',
          path: monitorAt(uuid),
          retry: 'safe',
          body: monitorBodyFrom(request, true),
        },
        options,
        monitorFrom,
      ),
    delete: async (uuid, options) => {
      await session.send({ method: 'DELETE', path: monitorAt(uuid), retry: 'safe' }, options)
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
        { method: 'GET', path: '/channels', retry: 'safe' },
        options,
        channelListFrom,
      ),
    get: async (id, options) =>
      read<Channel>({ method: 'GET', path: channelAt(id), retry: 'safe' }, options, channelFrom),
    create: async (request, options) =>
      read<Channel>(
        {
          method: 'POST',
          path: '/channels',
          retry: 'with-idempotency-key',
          body: channelBodyFrom(request),
          idempotencyKey: options?.idempotencyKey,
          // An email channel spends a verification-mail allowance of its own.
          separatelyThrottled: true,
        },
        options,
        channelFrom,
      ),
    rename: async (id, label, options) => {
      assertChannelLabel(label)

      return read<Channel>(
        { method: 'PATCH', path: channelAt(id), retry: 'safe', body: { label } },
        options,
        channelFrom,
      )
    },
    delete: async (id, options) => {
      await session.send({ method: 'DELETE', path: channelAt(id), retry: 'safe' }, options)
    },
    rotateSecret: async (id, options) =>
      read<RotatedChannelSecret>(
        { method: 'POST', path: channelAt(id, '/rotate-secret'), retry: 'never' },
        options,
        rotatedSecretFrom,
      ),
    // Never retried: it delivers a real message and spends a burst allowance that is not
    // the account's API rate limit, so a repeat is a second notification, not a retry.
    test: async (id, options) =>
      read<ChannelTestResult>(
        {
          method: 'POST',
          path: channelAt(id, '/test'),
          retry: 'never',
          deliversDownstream: true,
          separatelyThrottled: true,
        },
        options,
        channelTestFrom,
      ),
  }

  const account: AccountApi = {
    get: async (options) =>
      read<Account>({ method: 'GET', path: '/account', retry: 'safe' }, options, accountFrom),
  }

  // A function rather than an accessor: every other member of this object survives being
  // destructured off it, which is the whole reason the client is a factory.
  return { monitors, channels, account, rateLimit: () => session.rateLimit }
}
