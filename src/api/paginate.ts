import { API_MAX_PAGES } from './constants.js'
import { ApiHydrationError, ApiTransportError } from './errors.js'
import type { OffsetPage } from './types.js'

function exhausted(what: string): ApiTransportError {
  return new ApiTransportError(
    'unbounded',
    `Walking the ${what} listing passed ${API_MAX_PAGES} pages without reaching the end. Something is answering without advancing, and this client stops rather than looping.`,
  )
}

// Two monitors created in the same second have no defined relative order, because that
// listing has no tiebreaker, so a deep walk can hand back a row twice or skip one entirely.
// Skipping is not fixable from here; repeats are, and are dropped by identity. Do not build
// anything on the assumption that two monitor walks of an unchanged account agree. Alerts
// share this walk and are a total order, so for them the dropping is a no-op, not a need.
export async function* offsetWalk<T>(
  what: string,
  identify: (item: T) => string,
  page: (limit: number, offset: number) => Promise<OffsetPage<T>>,
  limit: number,
  from: number,
): AsyncIterableIterator<T> {
  const seen = new Set<string>()
  let offset = from
  let pages = 0

  for (;;) {
    if (pages >= API_MAX_PAGES) {
      throw exhausted(what)
    }

    const answered = await page(limit, offset)
    pages += 1

    if (answered.limit < 1) {
      throw new ApiHydrationError(
        `The ${what} listing echoed a page size of ${answered.limit}, which no walk can make progress against.`,
      )
    }

    for (const item of answered.data) {
      const id = identify(item)

      if (!seen.has(id)) {
        seen.add(id)

        yield item
      }
    }

    offset += answered.data.length

    if (answered.data.length === 0 || answered.data.length < answered.limit || offset >= answered.total) {
      return
    }
  }
}

export interface CursorPage<T> {
  readonly data: readonly T[]
  readonly nextCursor: string | null
}

// A cursor the service cannot decode is ignored rather than rejected, and the listing then
// answers from the beginning — so a corrupted cursor is an endless walk, not an error. A
// cursor that comes back a second time is the only observable form of that, and it stops.
export async function* cursorWalk<T>(
  what: string,
  page: (limit: number, cursor: string | undefined) => Promise<CursorPage<T>>,
  limit: number,
  from: string | undefined,
): AsyncIterableIterator<T> {
  const handedBack = new Set<string>()
  let cursor = from
  let pages = 0

  for (;;) {
    if (pages >= API_MAX_PAGES) {
      throw exhausted(what)
    }

    const answered = await page(limit, cursor)
    pages += 1

    for (const item of answered.data) {
      yield item
    }

    if (answered.nextCursor === null) {
      return
    }

    if (handedBack.has(answered.nextCursor)) {
      throw new ApiTransportError(
        'unbounded',
        `The ${what} listing handed back a cursor it had already handed back. A cursor the service cannot decode restarts the walk instead of failing, so this client stops rather than reading the same page forever.`,
      )
    }

    handedBack.add(answered.nextCursor)
    cursor = answered.nextCursor
  }
}
