import { describe, expect, it } from 'vitest'
import { API_PAGE_LIMIT_DEFAULT, API_PAGE_LIMIT_MAX } from '../src/api/constants.js'
import { ApiInvalidRequestError, ApiTransportError } from '../src/api/errors.js'
import {
  ALERT_JSON,
  CHANNEL_JSON,
  MONITOR_JSON,
  MONITOR_UUID,
  PING_JSON,
  type RecordedRequest,
  apiWith,
  streamingFetch,
} from './support/api-recorder.js'
import type { FetchLike } from '../src/ping/types.js'

function query(request: RecordedRequest | undefined): URLSearchParams {
  return new URL(String(request?.url)).searchParams
}

function monitor(uuid: string) {
  return { ...MONITOR_JSON, uuid }
}

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
]

async function collect<T>(iterator: AsyncIterableIterator<T>): Promise<T[]> {
  const seen: T[] = []

  for await (const item of iterator) {
    seen.push(item)
  }

  return seen
}

function encoded(json: unknown, chunkBytes: number): FetchLike {
  return streamingFetch(new TextEncoder().encode(JSON.stringify(json)), chunkBytes).fetch
}

describe('a page that arrives as a stream', () => {
  it('hydrates whole, because what bounds a check-in reply does not bound a management page', async () => {
    const data = UUIDS.flatMap((uuid) =>
      Array.from({ length: 40 }, (_, index) => ({ ...monitor(uuid), name: `job-${index}` })),
    )
    const { api } = apiWith(
      {},
      { fetch: encoded({ data, total: data.length, limit: API_PAGE_LIMIT_MAX, offset: 0 }, 4096) },
    )

    const page = await api.monitors.list({ limit: API_PAGE_LIMIT_MAX })

    expect(page.data).toHaveLength(data.length)
    expect(page.data.at(-1)?.name).toBe('job-39')
  })

  it('decodes a character the chunks cut in half, rather than replacing it', async () => {
    const named = { ...monitor(UUIDS[0] ?? ''), name: 'nightly-café' }
    const { api } = apiWith(
      {},
      { fetch: encoded({ data: [named], total: 1, limit: 50, offset: 0 }, 1) },
    )

    const page = await api.monitors.list()

    expect(page.data[0]?.name).toBe('nightly-café')
  })
})

describe('offset listings', () => {
  it('asks for the default page size and the first page when told nothing', async () => {
    const { api, recorder } = apiWith({ json: { data: [], total: 0, limit: 50, offset: 0 } })

    await api.monitors.list()

    expect(query(recorder.requests[0]).get('limit')).toBe(String(API_PAGE_LIMIT_DEFAULT))
    expect(query(recorder.requests[0]).get('offset')).toBe('0')
  })

  it('lowers a page size the service would silently clamp, rather than letting it echo back short', async () => {
    const { api, recorder } = apiWith({ json: { data: [], total: 0, limit: 100, offset: 0 } })

    await api.monitors.list({ limit: 5000 })

    expect(query(recorder.requests[0]).get('limit')).toBe(String(API_PAGE_LIMIT_MAX))
  })

  it('refuses a page size or offset that is not a whole number in range', async () => {
    const { api } = apiWith({ json: { data: [], total: 0, limit: 50, offset: 0 } })

    await expect(api.monitors.list({ limit: 0 })).rejects.toBeInstanceOf(ApiInvalidRequestError)
    await expect(api.monitors.list({ limit: 1.5 })).rejects.toBeInstanceOf(ApiInvalidRequestError)
    await expect(api.monitors.list({ offset: -1 })).rejects.toBeInstanceOf(ApiInvalidRequestError)
  })

  it('walks page by page and stops on a page shorter than the size it echoed', async () => {
    const { api, recorder } = apiWith((request) =>
      query(request).get('offset') === '0'
        ? { json: { data: [monitor(UUIDS[0] ?? ''), monitor(UUIDS[1] ?? '')], total: 3, limit: 2, offset: 0 } }
        : { json: { data: [monitor(UUIDS[2] ?? '')], total: 3, limit: 2, offset: 2 } },
    )

    const walked = await collect(api.monitors.iterate({ limit: 2 }))

    expect(walked.map((one) => one.uuid)).toEqual(UUIDS)
    expect(recorder.requests).toHaveLength(2)
  })

  it('drops a row a second-precision ordering handed back twice, rather than yielding it twice', async () => {
    const { api } = apiWith((request) =>
      query(request).get('offset') === '0'
        ? { json: { data: [monitor(UUIDS[0] ?? ''), monitor(UUIDS[1] ?? '')], total: 4, limit: 2, offset: 0 } }
        : { json: { data: [monitor(UUIDS[1] ?? ''), monitor(UUIDS[2] ?? '')], total: 4, limit: 2, offset: 2 } },
    )

    const walked = await collect(api.monitors.iterate({ limit: 2 }))

    expect(walked.map((one) => one.uuid)).toEqual(UUIDS)
  })

  it('stops rather than looping when a listing keeps answering full pages that go nowhere', async () => {
    const { api, recorder } = apiWith({
      json: { data: [monitor(UUIDS[0] ?? '')], total: 9999999, limit: 1, offset: 0 },
    })

    await expect(collect(api.monitors.iterate({ limit: 1 }))).rejects.toBeInstanceOf(
      ApiTransportError,
    )
    expect(recorder.requests.length).toBeGreaterThan(100)
  })

  it('refuses to walk a listing that echoes a page size nothing can advance against', async () => {
    const { api } = apiWith({ json: { data: [monitor(UUIDS[0] ?? '')], total: 9, limit: 0, offset: 0 } })

    await expect(collect(api.monitors.iterate())).rejects.toThrow(/page size/i)
  })

  it('walks alerts the same way, though their order is total and needs no deduplication', async () => {
    const { api } = apiWith((request) =>
      query(request).get('offset') === '0'
        ? { json: { data: [ALERT_JSON], total: 2, limit: 1, offset: 0 } }
        : { json: { data: [{ ...ALERT_JSON, id: '78' }], total: 2, limit: 1, offset: 1 } },
    )

    const walked = await collect(api.monitors.iterateAlerts(MONITOR_UUID, { limit: 1 }))

    expect(walked.map((one) => one.id)).toEqual(['77', '78'])
  })
})

describe('the cursor listing', () => {
  it('follows the cursor it is handed and stops when the service hands back none', async () => {
    const { api, recorder } = apiWith((request) =>
      query(request).get('cursor') === null
        ? { json: { data: [PING_JSON], next_cursor: 'b3BhcXVl' } }
        : { json: { data: [{ ...PING_JSON, id: '2' }], next_cursor: null } },
    )

    const walked = await collect(api.monitors.iteratePings(MONITOR_UUID))

    expect(walked.map((one) => one.id)).toEqual([PING_JSON.id, '2'])
    expect(query(recorder.requests[1]).get('cursor')).toBe('b3BhcXVl')
  })

  it('never sends a cursor parameter it was not given', async () => {
    const { api, recorder } = apiWith({ json: { data: [], next_cursor: null } })

    await api.monitors.pings(MONITOR_UUID)

    expect(query(recorder.requests[0]).has('cursor')).toBe(false)
  })

  it('stops when the same cursor comes back, because an undecodable one restarts the walk', async () => {
    const { api, recorder } = apiWith({ json: { data: [PING_JSON], next_cursor: 'stuck' } })

    await expect(collect(api.monitors.iteratePings(MONITOR_UUID))).rejects.toThrow(
      /already handed back/i,
    )
    expect(recorder.requests).toHaveLength(2)
  })
})

describe('the channels listing', () => {
  it('is one call over the whole set, with no pagination parameters on the wire', async () => {
    const { api, recorder } = apiWith({ json: { data: [CHANNEL_JSON], total: 1 } })

    const listed = await api.channels.list()

    expect(listed.data).toHaveLength(1)
    expect(listed.total).toBe(1)
    expect(recorder.requests).toHaveLength(1)
    expect(new URL(String(recorder.requests[0]?.url)).search).toBe('')
  })

  it('offers nothing that would walk it, because a walk of it could not terminate', async () => {
    const { api } = apiWith({ json: { data: [], total: 0 } })
    const surface = api.channels as unknown as Record<string, unknown>

    const listed = (await api.channels.list()) as unknown as Record<symbol | string, unknown>

    expect(Object.keys(surface).filter((name) => /iterate|walk|pages/i.test(name))).toEqual([])
    expect(surface[Symbol.asyncIterator as unknown as string]).toBeUndefined()
    expect(listed[Symbol.asyncIterator]).toBeUndefined()
    expect(listed[Symbol.iterator]).toBeUndefined()
  })
})
