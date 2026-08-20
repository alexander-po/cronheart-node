import { createCronheartApi } from '../../src/api/client.js'
import { unsafelyManaged } from '../../src/api/__selftest__.js'
import type { CronheartApi, CronheartApiOptions } from '../../src/api/types.js'
import type { FetchLike, PingHttpResponse, PingRequestInit } from '../../src/ping/types.js'
import { detachedCountdown } from '../../src/timer.js'

// Shaped like a key the service issues and deliberately shorter than one, assembled rather
// than written out so that no line in this repository looks like a credential to a scanner.
export const API_KEY = `cmk_${'0'.repeat(28)}synthetic`

export const BASE_URL = 'https://api.example'

export const MONITOR_UUID = '00000000-0000-4000-8000-0000000000e5'

export const CHANNEL_ID = '4611686018427387904'

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | undefined
}

export interface ApiStub {
  readonly status?: number | undefined
  readonly json?: unknown
  readonly body?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly rejectWith?: unknown
  readonly hang?: boolean | undefined
  readonly delayMs?: number | undefined
}

export type ApiResponder = (request: RecordedRequest, attempt: number) => ApiStub

export interface ApiRecorder {
  readonly fetch: FetchLike
  readonly requests: readonly RecordedRequest[]
  readonly undrainedBodies: number
  respondWith(next: ApiResponder | ApiStub): void
}

export function createApiRecorder(initial?: ApiResponder | ApiStub): ApiRecorder {
  const requests: RecordedRequest[] = []
  const drained: { consumed: boolean }[] = []
  let responder: ApiResponder = () => ({})

  const recorder: ApiRecorder = {
    fetch: (url: string, init: PingRequestInit) => {
      const request: RecordedRequest = {
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
      }
      requests.push(request)

      const stub = responder(request, requests.length)

      if (stub.hang === true) {
        return new Promise<PingHttpResponse>(() => {})
      }

      if ('rejectWith' in stub) {
        return Promise.reject(stub.rejectWith)
      }

      const state = { consumed: false }
      drained.push(state)
      const text = stub.body ?? (stub.json === undefined ? '' : JSON.stringify(stub.json))

      const response: PingHttpResponse = {
        status: stub.status ?? 200,
        headers: { get: (name) => stub.headers?.[name.toLowerCase()] ?? null },
        get bodyUsed() {
          return state.consumed
        },
        body: {
          cancel: () => {
            state.consumed = true

            return Promise.resolve()
          },
        },
        text: async () => {
          state.consumed = true

          return text
        },
      }

      return stub.delayMs === undefined
        ? Promise.resolve(response)
        : detachedCountdown(stub.delayMs).reached.then(() => response)
    },
    get requests() {
      return requests
    },
    get undrainedBodies() {
      return drained.filter((state) => !state.consumed).length
    },
    respondWith: (next) => {
      responder = typeof next === 'function' ? next : () => next
    },
  }

  if (initial !== undefined) {
    recorder.respondWith(initial)
  }

  return recorder
}

export function apiWith(
  stub: ApiResponder | ApiStub,
  overrides: CronheartApiOptions = {},
): { api: CronheartApi; recorder: ApiRecorder } {
  const recorder = createApiRecorder(stub)
  const api = createCronheartApi({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    env: {},
    retries: 0,
    fetch: recorder.fetch,
    ...overrides,
  })

  return { api, recorder }
}

export const MONITOR_JSON = {
  uuid: MONITOR_UUID,
  name: 'nightly-backup',
  schedule_kind: 'cron',
  schedule_expr: '0 3 * * *',
  tz: 'UTC',
  grace_seconds: 60,
  channels: [{ id: CHANNEL_ID, kind: 'email', label: 'ops inbox' }],
  status: 'up',
  next_expected_at: '2026-08-21T03:00:00+00:00',
  snoozed_until: null,
  last_ping_at: '2026-08-20T03:00:04+00:00',
  created_at: '2026-08-01T09:15:00+00:00',
  ping_url: `${BASE_URL}/ping/${MONITOR_UUID}`,
  badge_url: `${BASE_URL}/badge/${MONITOR_UUID}.svg`,
}

export const CHANNEL_JSON = {
  id: CHANNEL_ID,
  kind: 'email',
  label: 'ops inbox',
  verified: true,
  config: { address: 'ops@example.invalid' },
  created_at: '2026-08-01T09:00:00+00:00',
}

export const PING_JSON = {
  id: '9007199254740993',
  kind: 'success',
  received_at: '2026-08-20T03:00:04+00:00',
  runtime_ms: 4120,
}

export const ALERT_JSON = {
  id: '77',
  kind: 'late',
  created_at: '2026-08-19T03:05:00+00:00',
  dispatched_to: { [CHANNEL_ID]: '2026-08-19T03:05:01+00:00' },
}

export const ACCOUNT_JSON = {
  plan: { key: 'starter', label: 'Starter', monitor_limit: 20 },
  monitor_budget: { used: 3, limit: 20, remaining: 17 },
  api_rate_limit: { limit: 120, remaining: 119 },
}

interface Call {
  readonly id: string
  run(api: CronheartApi): Promise<unknown>
}

async function drain(iterator: AsyncIterableIterator<unknown>): Promise<unknown[]> {
  const collected: unknown[] = []

  for await (const item of iterator) {
    collected.push(item)
  }

  return collected
}

export const EVERY_CALL: readonly Call[] = [
  { id: 'monitors.list', run: (api) => api.monitors.list() },
  { id: 'monitors.iterate', run: (api) => drain(api.monitors.iterate()) },
  { id: 'monitors.get', run: (api) => api.monitors.get(MONITOR_UUID) },
  {
    id: 'monitors.create',
    run: (api) =>
      api.monitors.create({
        name: 'nightly-backup',
        scheduleKind: 'cron',
        scheduleExpr: '0 3 * * *',
        channelIds: [CHANNEL_ID],
      }),
  },
  { id: 'monitors.update', run: (api) => api.monitors.update(MONITOR_UUID, { name: 'renamed' }) },
  { id: 'monitors.delete', run: (api) => api.monitors.delete(MONITOR_UUID) },
  { id: 'monitors.pause', run: (api) => api.monitors.pause(MONITOR_UUID) },
  { id: 'monitors.resume', run: (api) => api.monitors.resume(MONITOR_UUID) },
  { id: 'monitors.snooze', run: (api) => api.monitors.snooze(MONITOR_UUID, '1h') },
  { id: 'monitors.unsnooze', run: (api) => api.monitors.unsnooze(MONITOR_UUID) },
  { id: 'monitors.rotateUuid', run: (api) => api.monitors.rotateUuid(MONITOR_UUID) },
  { id: 'monitors.pings', run: (api) => api.monitors.pings(MONITOR_UUID) },
  { id: 'monitors.iteratePings', run: (api) => drain(api.monitors.iteratePings(MONITOR_UUID)) },
  { id: 'monitors.alerts', run: (api) => api.monitors.alerts(MONITOR_UUID) },
  { id: 'monitors.iterateAlerts', run: (api) => drain(api.monitors.iterateAlerts(MONITOR_UUID)) },
  { id: 'channels.list', run: (api) => api.channels.list() },
  { id: 'channels.get', run: (api) => api.channels.get(CHANNEL_ID) },
  {
    id: 'channels.create',
    run: (api) => api.channels.create({ kind: 'email', label: 'ops inbox', address: 'ops@example.invalid' }),
  },
  { id: 'channels.rename', run: (api) => api.channels.rename(CHANNEL_ID, 'ops') },
  { id: 'channels.delete', run: (api) => api.channels.delete(CHANNEL_ID) },
  { id: 'channels.rotateSecret', run: (api) => api.channels.rotateSecret(CHANNEL_ID) },
  { id: 'channels.test', run: (api) => api.channels.test(CHANNEL_ID) },
  { id: 'account.get', run: (api) => api.account.get() },
]

export const FAILURE_MODES: readonly { id: string; stub: ApiStub }[] = [
  { id: '401', stub: { status: 401, json: { status: 401, detail: 'security.token.invalid' } } },
  { id: '402', stub: { status: 402, json: { status: 402, upgrade_url: 'https://billing.example' } } },
  { id: '403', stub: { status: 403, json: { status: 403, detail: 'Monitor limit reached.' } } },
  { id: '404', stub: { status: 404, json: { status: 404 } } },
  { id: '409', stub: { status: 409, json: { status: 409, detail: 'Already in progress.' } } },
  {
    id: '422',
    stub: { status: 422, json: { status: 422, errors: { name: 'This value is too short.' } } },
  },
  {
    id: '429',
    stub: { status: 429, json: { status: 429, retry_after: 12 }, headers: { 'retry-after': '12' } },
  },
  { id: '500', stub: { status: 500, body: '<html>upstream said no</html>' } },
  { id: '502', stub: { status: 502, json: { status: 502 } } },
  { id: 'not-json', stub: { status: 200, body: 'not json at all' } },
  { id: 'wrong-shape', stub: { status: 200, json: { data: 'not a list' } } },
  { id: 'rejects', stub: { rejectWith: new Error('socket hang up') } },
  { id: 'rejects-a-string', stub: { rejectWith: 'a bare string' } },
]

// Fixed rather than counted, because it asserts something: a cause chain would add five
// more per value, and this client attaches no cause anywhere.
export const SURFACES_PER_VALUE = 6

export interface Sweep {
  readonly surfacesInspected: number
  readonly mentioningTheKey: string[]
  readonly failures: unknown[]
  // Which routes actually produced a failure. The leaking variant swaps the subject rather
  // than injecting a defect into it, so a green control proves the sweep can see a key and
  // proves nothing about whether the sweep is pointed at the real client. This is what pins
  // that: a route that stopped being exercised drops out of here rather than going quiet.
  readonly routesThatFailed: readonly string[]
  // The pairs that answered instead of failing, named: a route that quietly stopped
  // producing one would otherwise only move a total nobody reads.
  readonly succeeded: readonly string[]
}

function describeQuietly(value: unknown, depth = 0): string[] {
  const parts: string[] = []

  for (const read of [
    () => String(value),
    () => (value instanceof Error ? value.message : ''),
    () => (value instanceof Error ? (value.stack ?? '') : ''),
    () => JSON.stringify(value) ?? '',
    () =>
      typeof value === 'object' && value !== null
        ? Object.entries(value)
            .map(([key, member]) => `${key}=${String(member)}`)
            .join(' ')
        : '',
  ]) {
    try {
      parts.push(read())
    } catch {
      parts.push('')
    }
  }

  if (depth < 3 && value instanceof Error && value.cause !== undefined) {
    parts.push(...describeQuietly(value.cause, depth + 1))
  }

  return parts
}

function captureOutput(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const sink = console as unknown as Record<string, unknown>
  const previous = new Map<string, unknown>()

  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    previous.set(method, sink[method])
    sink[method] = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '))
    }
  }

  return {
    lines,
    restore: () => {
      for (const [method, original] of previous) {
        sink[method] = original
      }
    },
  }
}

export async function describeEverySurfaceOf({ leak = false } = {}): Promise<Sweep> {
  const mentioningTheKey: string[] = []
  const failures: unknown[] = []
  const routesThatFailed = new Set<string>()
  const succeeded: string[] = []
  let surfacesInspected = 0

  for (const mode of FAILURE_MODES) {
    for (const call of leak ? EVERY_CALL.slice(0, 1) : EVERY_CALL) {
      const recorder = createApiRecorder(mode.stub)
      const options: CronheartApiOptions = {
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        env: {},
        retries: 0,
        fetch: recorder.fetch,
      }
      const capture = captureOutput()
      let thrown: unknown

      try {
        await (leak ? unsafelyManaged(options) : call.run(createCronheartApi(options)))
        succeeded.push(`${call.id} / ${mode.id}`)
      } catch (error) {
        thrown = error
        failures.push(error)
        routesThatFailed.add(call.id)
      } finally {
        capture.restore()
      }

      for (const surface of [...describeQuietly(thrown), capture.lines.join('\n')]) {
        surfacesInspected += 1

        if (surface.includes(API_KEY) || /cmk_[A-Za-z0-9]/.test(surface)) {
          mentioningTheKey.push(`${call.id} / ${mode.id}`)
        }
      }
    }
  }

  return {
    surfacesInspected,
    mentioningTheKey,
    failures,
    routesThatFailed: [...routesThatFailed].sort(),
    succeeded: succeeded.sort(),
  }
}
