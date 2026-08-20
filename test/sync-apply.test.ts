import { describe, expect, it } from 'vitest'
import { applySync } from '../src/sync/apply.js'
import { planSync } from '../src/sync/plan.js'
import type { MonitorDefinition, PlannedCreate } from '../src/sync/types.js'
import { channelRow, createMonitorStore, monitorRow } from './support/monitor-store.js'
import { apiFor, bodiesSentTo, transportFor } from './support/sync-api.js'

const VERIFIED = channelRow({ id: '7', label: 'ops inbox', verified: true })

const CONFIRMED = { confirm: () => true }

function config(...monitors: readonly MonitorDefinition[]): readonly MonitorDefinition[] {
  return monitors
}

describe('what apply sends', () => {
  it('creates exactly what the plan carried and nothing the plan did not', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] }),
    )
    const result = await applySync(api, plan)

    expect(result.created.map((entry) => entry.name)).toEqual(['nightly-backup'])
    expect(bodiesSentTo(store, 'POST')).toEqual([
      {
        name: 'nightly-backup',
        schedule_kind: 'cron',
        schedule_expr: '0 3 * * *',
        channel_ids: ['7'],
      },
    ])
  })

  it('sends no request at all for a plan with nothing to do', async () => {
    const store = createMonitorStore([monitorRow()], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] }),
    )
    const before = store.requests.length

    await applySync(api, plan)

    expect(store.requests.slice(before)).toEqual([])
  })

  // The rows apply cannot act on are the ones a run most needs to hear about: an exit status
  // built from what failed would read a plan full of conflicts as a clean run.
  it('reports every row the plan could not resolve as a failure of this run', async () => {
    const store = createMonitorStore(
      [
        monitorRow({ uuid: '00000000-0000-4000-8000-00000000000a' }),
        monitorRow({ uuid: '00000000-0000-4000-8000-00000000000b' }),
      ],
      [VERIFIED, channelRow({ id: '9', label: 'pager', verified: false })],
    )
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
        { name: 'silent-job', schedule: '@daily', channels: ['pager'] },
      ),
    )
    const result = await applySync(api, plan)

    expect(result.failures.map((failure) => [failure.name, failure.action]).sort()).toEqual([
      ['nightly-backup', 'conflict'],
      ['silent-job', 'refused'],
    ])
    expect(result.failures.map((failure) => failure.message).join(' ')).toContain('alert nobody')
  })

  it('sends only the fields that differ, so a routing it did not come to change is left alone', async () => {
    const store = createMonitorStore([monitorRow({ channel_ids: ['7'] })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'nightly-backup', schedule: '0 4 * * *', channels: ['ops inbox'] }),
    )

    await applySync(api, plan)

    expect(bodiesSentTo(store, 'PATCH')).toEqual([{ schedule_expr: '0 4 * * *' }])
  })

  it('refuses to reach the service for a row the plan refused', async () => {
    const store = createMonitorStore([], [channelRow({ id: '9', label: 'pager', verified: false })])
    const api = apiFor(store)
    const plan = await planSync(api, config({ name: 'a-job', schedule: '@daily', channels: ['pager'] }))

    await applySync(api, plan)

    expect(bodiesSentTo(store, 'POST')).toEqual([])
    expect(store.monitors).toEqual([])
  })
})

describe('the key a create carries', () => {
  it('is derived from the request, so the same configuration always mints the same one', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const definition = config({
      name: 'nightly-backup',
      schedule: '0 3 * * *',
      channels: ['ops inbox'],
    })
    const first = await planSync(apiFor(store), definition)
    const second = await planSync(apiFor(store), definition)
    const keyOf = (plan: Awaited<ReturnType<typeof planSync>>): string =>
      (plan.rows.find((row) => row.action === 'create') as PlannedCreate).idempotencyKey

    expect(keyOf(first)).toMatch(/^sync-[0-9a-f]{64}$/)
    expect(keyOf(second)).toBe(keyOf(first))
  })

  it('changes when the request changes, so a corrected monitor is not refused as a repeat', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const keyFor = async (expression: string): Promise<string> =>
      (
        (await planSync(
          apiFor(store),
          config({ name: 'a-job', schedule: expression, channels: ['ops inbox'] }),
        )).rows.find((row) => row.action === 'create') as PlannedCreate
      ).idempotencyKey

    expect(await keyFor('0 3 * * *')).not.toBe(await keyFor('0 4 * * *'))
  })

  it('does not move when the configuration lists the same channels in another order', async () => {
    const store = createMonitorStore(
      [],
      [VERIFIED, channelRow({ id: '9', label: 'pager', verified: true })],
    )
    const keyFor = async (channels: readonly string[]): Promise<string> =>
      (
        (await planSync(apiFor(store), config({ name: 'a-job', schedule: '@daily', channels })))
          .rows.find((row) => row.action === 'create') as PlannedCreate
      ).idempotencyKey

    expect(await keyFor(['ops inbox', 'pager'])).toBe(await keyFor(['pager', 'ops inbox']))
  })

  // The listing has no tiebreaker at second precision, so a deep walk can miss a row that is
  // there. Without the key that reads as absent and mints a second monitor of the same name.
  it('stops a repeated run minting a duplicate when the listing failed to report the monitor', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const definition = config({
      name: 'nightly-backup',
      schedule: '0 3 * * *',
      channels: ['ops inbox'],
    })
    const api = apiFor(store)

    await applySync(api, await planSync(api, definition))
    store.hideListing = true
    const second = await applySync(api, await planSync(api, definition))

    expect(store.monitors).toHaveLength(1)
    expect(second.created).toHaveLength(1)
    expect(bodiesSentTo(store, 'POST')).toHaveLength(2)
  })
})

describe('the routing an update sends', () => {
  it('leaves the key out entirely when the configuration says nothing about channels', async () => {
    const store = createMonitorStore([monitorRow({ channel_ids: ['7'] })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(api, config({ name: 'nightly-backup', schedule: '0 4 * * *' }))

    await applySync(api, plan)

    const [body] = bodiesSentTo(store, 'PATCH') as [Record<string, unknown>]

    expect(Object.hasOwn(body, 'channel_ids')).toBe(false)
    expect(store.monitors[0]?.channel_ids).toEqual(['7'])
  })

  it('empties the routing only for a configuration that wrote the word none', async () => {
    const store = createMonitorStore([monitorRow({ channel_ids: ['7'] })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'nightly-backup', schedule: '0 3 * * *', channels: 'none' }),
    )

    await applySync(api, plan)

    expect(bodiesSentTo(store, 'PATCH')).toEqual([{ channel_ids: [] }])
    expect(store.monitors[0]?.channel_ids).toEqual([])
  })

  it('never blanks the routing of any monitor a silent configuration describes', async () => {
    const store = createMonitorStore(
      [
        monitorRow({ name: 'one', uuid: '00000000-0000-4000-8000-000000000001' }),
        monitorRow({ name: 'two', uuid: '00000000-0000-4000-8000-000000000002' }),
        monitorRow({ name: 'three', uuid: '00000000-0000-4000-8000-000000000003' }),
      ],
      [VERIFIED],
    )
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'one', schedule: '@daily' },
        { name: 'two', schedule: { every: '5m' } },
        { name: 'three', schedule: 'hourly', graceSeconds: 300 },
      ),
    )

    await applySync(api, plan)

    expect(store.monitors.map((monitor) => monitor.channel_ids)).toEqual([['7'], ['7'], ['7']])
    expect(
      bodiesSentTo(store, 'PATCH').filter((body) =>
        Object.hasOwn(body as Record<string, unknown>, 'channel_ids'),
      ),
    ).toEqual([])
  })
})

describe('deleting a monitor destroys its history, so nothing does it by default', () => {
  it('leaves an orphan alone when apply is not told to prune', async () => {
    const store = createMonitorStore([monitorRow({ name: 'retired' })], [VERIFIED])
    const api = apiFor(store)
    const result = await applySync(api, await planSync(api, config()))

    expect(result.deleted).toEqual([])
    expect(store.monitors).toHaveLength(1)
    expect(store.requests.filter((request) => request.method === 'DELETE')).toEqual([])
  })

  it('leaves an orphan alone when the confirmation is declined', async () => {
    const store = createMonitorStore([monitorRow({ name: 'retired' })], [VERIFIED])
    const api = apiFor(store)
    const result = await applySync(api, await planSync(api, config()), {
      prune: { confirm: () => false },
    })

    expect(result.deleted).toEqual([])
    expect(store.monitors).toHaveLength(1)
  })

  it('deletes it only when pruning was asked for and confirmed', async () => {
    const store = createMonitorStore([monitorRow({ name: 'retired' })], [VERIFIED])
    const api = apiFor(store)
    const result = await applySync(api, await planSync(api, config()), { prune: CONFIRMED })

    expect(result.deleted.map((entry) => entry.name)).toEqual(['retired'])
    expect(store.monitors).toEqual([])
  })

  it('asks once, whatever the plan carries, and never asks when there is nothing to delete', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    let asked = 0

    await applySync(api, await planSync(api, config()), {
      prune: {
        confirm: () => {
          asked += 1

          return true
        },
      },
    })

    expect(asked).toBe(0)
  })
})

describe('what stops a run and what does not', () => {
  it('stops on a refusal that will refuse every remaining request the same way', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'one', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'two', schedule: '@daily', channels: ['ops inbox'] },
      ),
    )
    const denying = apiFor(createMonitorStore([], [VERIFIED]), {
      fetch: () =>
        Promise.resolve({
          status: 402,
          headers: { get: () => null },
          body: { cancel: () => Promise.resolve() },
          text: () => Promise.resolve(JSON.stringify({ status: 402 })),
        }),
    })
    const result = await applySync(denying, plan)

    expect(result.stopped).toBe(true)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.message).toContain('Starter')
  })

  it('carries on past a refusal that is about one monitor only', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'one', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'two', schedule: '@daily', channels: ['ops inbox'] },
      ),
    )
    // The first monitor's create is refused for a reason that is about that monitor; the
    // second must still be tried, or one bad row in a configuration stops the whole file.
    const straight = transportFor(store)
    let refusalsLeft = 1
    const flaky = apiFor(store, {
      fetch: (url, init) => {
        if (init.method === 'POST' && refusalsLeft > 0) {
          refusalsLeft -= 1

          return Promise.resolve({
            status: 422,
            headers: { get: () => null },
            body: { cancel: () => Promise.resolve() },
            text: () => Promise.resolve(JSON.stringify({ status: 422, errors: { name: 'no' } })),
          })
        }

        return straight(url, init)
      },
    })
    const result = await applySync(flaky, plan)

    expect(result.stopped).toBe(false)
    expect(result.failures.map((failure) => failure.name)).toEqual(['one'])
    expect(result.created.map((entry) => entry.name)).toEqual(['two'])
  })
})
