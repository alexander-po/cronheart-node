// A stand-in for the management surface, faithful to the facts sync turns on: monitor
// listings are offset-paged and ordered by creation time with no tiebreaker, names carry no
// uniqueness constraint, the channels listing reads no pagination parameters, an attached
// channel is projected without its verified flag and sorted by identifier, and a create
// carrying an idempotency key replays the stored response rather than making a second row.
export interface StoredMonitor {
  uuid: string
  name: string
  schedule_kind: string
  schedule_expr: string
  tz: string
  grace_seconds: number
  channel_ids: string[]
  created_at: string
  status: string
}

export interface StoredChannel {
  id: string
  kind: string
  label: string
  verified: boolean
  created_at: string
}

export interface StoreRequest {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly body: unknown
  readonly idempotencyKey: string | undefined
}

export interface StoreReply {
  readonly status: number
  readonly json: unknown
}

export interface MonitorStore {
  readonly monitors: StoredMonitor[]
  readonly channels: StoredChannel[]
  readonly requests: readonly StoreRequest[]
  // Set to have every monitor listing answer with an empty page while the rows stay in the
  // store: the shape a walk of an untiebroken offset listing produces when it skips a row.
  hideListing: boolean
  // Answers every management request the way a downgraded account does: authenticated, then
  // refused on entitlement. The check-in route is unaffected, which is the whole point of it.
  denyWithPlanRestriction: boolean
  nextUuid: string | undefined
  handle(request: StoreRequest): StoreReply
}

const MONITOR_PATH = /^\/api\/v1\/monitors(?:\/([^/]+))?(?:\/([^/]+))?$/

const CHANNELS_PATH = /^\/api\/v1\/channels$/

function digits(value: unknown, fallback: number): number {
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : fallback
}

function monitorJson(monitor: StoredMonitor, channels: readonly StoredChannel[]): unknown {
  const attached = monitor.channel_ids
    .map((id) => channels.find((channel) => channel.id === id))
    .filter((channel): channel is StoredChannel => channel !== undefined)
    .sort((one, other) => Number(one.id) - Number(other.id))

  return {
    uuid: monitor.uuid,
    name: monitor.name,
    schedule_kind: monitor.schedule_kind,
    schedule_expr: monitor.schedule_expr,
    tz: monitor.tz,
    grace_seconds: monitor.grace_seconds,
    channels: attached.map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      label: channel.label,
    })),
    status: monitor.status,
    next_expected_at: null,
    snoozed_until: null,
    last_ping_at: null,
    created_at: monitor.created_at,
    ping_url: `https://cronheart.example/ping/${monitor.uuid}`,
    badge_url: `https://cronheart.example/badge/${monitor.uuid}.svg`,
  }
}

function channelJson(channel: StoredChannel): unknown {
  return {
    id: channel.id,
    kind: channel.kind,
    label: channel.label,
    verified: channel.verified,
    config: { address: 'masked' },
    created_at: channel.created_at,
  }
}

function problem(status: number, detail: string): StoreReply {
  return { status, json: { type: 'about:blank', title: 'Problem', status, detail } }
}

function idsFrom(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : undefined
}

export function createMonitorStore(
  monitors: readonly StoredMonitor[] = [],
  channels: readonly StoredChannel[] = [],
): MonitorStore {
  const requests: StoreRequest[] = []
  const replayed = new Map<string, StoreReply>()
  let minted = 0

  const store: MonitorStore = {
    monitors: [...monitors],
    channels: [...channels],
    hideListing: false,
    denyWithPlanRestriction: false,
    nextUuid: undefined,
    get requests() {
      return requests
    },
    handle(request) {
      requests.push(request)

      // The check-in route lives on the same origin, so one stand-in answers both halves of
      // what a command that creates a monitor and then proves it works has to reach.
      if (request.path.startsWith('/ping/')) {
        return { status: 200, json: undefined }
      }

      if (store.denyWithPlanRestriction) {
        return {
          status: 402,
          json: { type: 'about:blank', status: 402, upgrade_url: 'https://billing.invalid' },
        }
      }

      if (CHANNELS_PATH.test(request.path)) {
        return {
          status: 200,
          json: { data: store.channels.map(channelJson), total: store.channels.length },
        }
      }

      const route = MONITOR_PATH.exec(request.path)

      if (route === null) {
        return problem(404, 'No route.')
      }

      const uuid = route[1]

      if (uuid === undefined) {
        if (request.method === 'GET') {
          const ordered = [...store.monitors].sort((one, other) =>
            other.created_at.localeCompare(one.created_at),
          )
          const limit = digits(request.query['limit'], 50)
          const offset = digits(request.query['offset'], 0)
          const page = store.hideListing ? [] : ordered.slice(offset, offset + limit)

          return {
            status: 200,
            json: {
              data: page.map((monitor) => monitorJson(monitor, store.channels)),
              total: store.hideListing ? 0 : ordered.length,
              limit,
              offset,
            },
          }
        }

        if (request.method !== 'POST') {
          return problem(405, 'Method not allowed.')
        }

        const key = request.idempotencyKey

        if (key !== undefined) {
          const stored = replayed.get(key)

          if (stored !== undefined) {
            return stored
          }
        }

        const body = (request.body ?? {}) as Record<string, unknown>
        minted += 1
        const created: StoredMonitor = {
          uuid: store.nextUuid ?? `00000000-0000-4000-8000-${String(minted).padStart(12, '0')}`,
          name: String(body['name']),
          schedule_kind: String(body['schedule_kind']),
          schedule_expr: String(body['schedule_expr']),
          tz: typeof body['tz'] === 'string' ? body['tz'] : 'UTC',
          grace_seconds: typeof body['grace_seconds'] === 'number' ? body['grace_seconds'] : 60,
          channel_ids: idsFrom(body['channel_ids']) ?? [],
          created_at: new Date(1_760_000_000_000 + minted * 1000).toISOString(),
          status: 'new',
        }
        store.nextUuid = undefined
        store.monitors.push(created)
        const reply: StoreReply = { status: 201, json: monitorJson(created, store.channels) }

        if (key !== undefined) {
          replayed.set(key, reply)
        }

        return reply
      }

      const found = store.monitors.find((monitor) => monitor.uuid === uuid)

      if (found === undefined) {
        return problem(404, 'No monitor.')
      }

      if (request.method === 'GET') {
        return { status: 200, json: monitorJson(found, store.channels) }
      }

      if (request.method === 'DELETE') {
        store.monitors.splice(store.monitors.indexOf(found), 1)

        return { status: 204, json: undefined }
      }

      if (request.method !== 'PATCH') {
        return problem(405, 'Method not allowed.')
      }

      const body = (request.body ?? {}) as Record<string, unknown>

      if (typeof body['name'] === 'string') {
        found.name = body['name']
      }

      if (typeof body['schedule_kind'] === 'string') {
        found.schedule_kind = body['schedule_kind']
      }

      if (typeof body['schedule_expr'] === 'string') {
        found.schedule_expr = body['schedule_expr']
      }

      if (typeof body['tz'] === 'string') {
        found.tz = body['tz']
      }

      if (typeof body['grace_seconds'] === 'number') {
        found.grace_seconds = body['grace_seconds']
      }

      // Present, even empty, replaces the routing wholesale; absent leaves it alone. The
      // store models that literally, so a client that sent an empty array by accident
      // silences the monitor here exactly as it would on the service.
      if (Object.hasOwn(body, 'channel_ids')) {
        found.channel_ids = idsFrom(body['channel_ids']) ?? []
      }

      return { status: 200, json: monitorJson(found, store.channels) }
    },
  }

  return store
}

export function monitorRow(overrides: Partial<StoredMonitor> = {}): StoredMonitor {
  return {
    uuid: '00000000-0000-4000-8000-0000000000a1',
    name: 'nightly-backup',
    schedule_kind: 'cron',
    schedule_expr: '0 3 * * *',
    tz: 'UTC',
    grace_seconds: 60,
    channel_ids: ['7'],
    created_at: '2026-08-01T09:15:00.000Z',
    status: 'up',
    ...overrides,
  }
}

export function channelRow(overrides: Partial<StoredChannel> = {}): StoredChannel {
  return {
    id: '7',
    kind: 'email',
    label: 'ops inbox',
    verified: true,
    created_at: '2026-08-01T09:00:00.000Z',
    ...overrides,
  }
}
