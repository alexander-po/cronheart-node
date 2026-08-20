import { describe, expect, it } from 'vitest'
import { applySync } from '../src/sync/apply.js'
import { planSync } from '../src/sync/plan.js'
import { renderResult } from '../src/sync/render.js'
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
    const store = createMonitorStore(
      [
        monitorRow({ name: 'kept' }),
        monitorRow({ name: 'retired', uuid: '00000000-0000-4000-8000-0000000000b2' }),
      ],
      [VERIFIED],
    )
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'kept', schedule: '0 3 * * *', channels: ['ops inbox'] }),
    )
    const result = await applySync(api, plan, { prune: CONFIRMED })

    expect(result.deleted.map((entry) => entry.name)).toEqual(['retired'])
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['kept'])
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

describe('what pruning waits for', () => {
  // Deleting is the irreversible half, and it is only ever safe once the half that would
  // replace what it deletes has landed. A refusal the plan itself raised is that half failing
  // before a request existed, which is the case a run is least likely to look at.
  it('deletes nothing when the row that would have replaced the orphan was refused', async () => {
    const store = createMonitorStore([monitorRow({ name: 'old-name' })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'new-name', schedule: '0 3 * * *', channels: ['ops inbxo'] }),
    )
    const result = await applySync(api, plan, { prune: CONFIRMED })

    expect(result.deleted).toEqual([])
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['old-name'])
    expect(store.requests.filter((request) => request.method === 'DELETE')).toEqual([])
  })

  it('deletes nothing when the create that would have replaced the orphan was refused on the wire', async () => {
    const store = createMonitorStore([monitorRow({ name: 'old-name' })], [VERIFIED])
    const straight = transportFor(store)
    const api = apiFor(store, {
      fetch: (url, init) =>
        init.method === 'POST'
          ? Promise.resolve({
              status: 422,
              headers: { get: () => null },
              body: { cancel: () => Promise.resolve() },
              text: () => Promise.resolve(JSON.stringify({ status: 422, errors: { name: 'no' } })),
            })
          : straight(url, init),
    })
    const plan = await planSync(
      api,
      config({ name: 'new-name', schedule: '0 3 * * *', channels: ['ops inbox'] }),
    )
    const result = await applySync(api, plan, { prune: CONFIRMED })

    expect(result.deleted).toEqual([])
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['old-name'])
  })

  it('does not even ask when the constructive half of the plan failed', async () => {
    const store = createMonitorStore([monitorRow({ name: 'old-name' })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'new-name', schedule: '0 3 * * *', channels: ['ops inbxo'] }),
    )
    let asked = 0

    await applySync(api, plan, {
      prune: {
        confirm: () => {
          asked += 1

          return true
        },
      },
    })

    expect(asked).toBe(0)
  })

  // A glob that matched nothing, a truncated write and a list built from an unset variable all
  // arrive here as the same document, and none of them is an instruction to empty the account.
  it('deletes nothing for a configuration that describes no monitors at all', async () => {
    const store = createMonitorStore(
      [
        monitorRow({ name: 'one', uuid: '00000000-0000-4000-8000-000000000001' }),
        monitorRow({ name: 'two', uuid: '00000000-0000-4000-8000-000000000002' }),
      ],
      [VERIFIED],
    )
    const api = apiFor(store)
    const result = await applySync(api, await planSync(api, config()), { prune: CONFIRMED })

    expect(result.deleted).toEqual([])
    expect(store.monitors).toHaveLength(2)
    expect(result.pruneSkipped).toContain('describes no monitors')
  })

  it('still prunes when every row the configuration described landed', async () => {
    const store = createMonitorStore(
      [
        monitorRow({ name: 'kept' }),
        monitorRow({ name: 'retired', uuid: '00000000-0000-4000-8000-000000000002' }),
      ],
      [VERIFIED],
    )
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config({ name: 'kept', schedule: '0 3 * * *', channels: ['ops inbox'] }),
    )
    const result = await applySync(api, plan, { prune: CONFIRMED })

    expect(result.deleted.map((entry) => entry.name)).toEqual(['retired'])
    expect(store.monitors.map((monitor) => monitor.name)).toEqual(['kept'])
  })
})

describe('a refusal that is account-wide for creates alone', () => {
  it('stops the remaining creates instead of collecting one identical refusal per monitor', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'one', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'two', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'three', schedule: '@daily', channels: ['ops inbox'] },
      ),
    )
    const straight = transportFor(store)
    let creates = 0
    const denying = apiFor(store, {
      fetch: (url, init) => {
        if (init.method !== 'POST') {
          return straight(url, init)
        }

        creates += 1

        return Promise.resolve({
          status: 403,
          headers: { get: () => null },
          body: { cancel: () => Promise.resolve() },
          text: () => Promise.resolve(JSON.stringify({ status: 403 })),
        })
      },
    })
    const result = await applySync(denying, plan)

    expect(creates).toBe(1)
    expect(result.failures.map((failure) => failure.name)).toEqual(['one', 'two', 'three'])
    expect(result.failures.slice(1).map((failure) => failure.message).join(' ')).toContain('skipped')
    expect(result.stopped).toBe(false)
  })

  it('leaves the updates of the same run alone, because the refusal is about creating', async () => {
    const store = createMonitorStore([monitorRow({ name: 'existing' })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(
      api,
      config(
        { name: 'fresh', schedule: '@daily', channels: ['ops inbox'] },
        { name: 'existing', schedule: '0 4 * * *', channels: ['ops inbox'] },
      ),
    )
    const straight = transportFor(store)
    const denying = apiFor(store, {
      fetch: (url, init) =>
        init.method === 'POST'
          ? Promise.resolve({
              status: 403,
              headers: { get: () => null },
              body: { cancel: () => Promise.resolve() },
              text: () => Promise.resolve(JSON.stringify({ status: 403 })),
            })
          : straight(url, init),
    })
    const result = await applySync(denying, plan)

    expect(result.updated.map((entry) => entry.name)).toEqual(['existing'])
    expect(store.monitors[0]?.schedule_expr).toBe('0 4 * * *')
  })
})

describe('how long a create cannot be repeated for', () => {
  // The key reserves a row that a sweep deletes on a cutoff, so a repeat past that cutoff is
  // executed rather than replayed. Beyond the window the listing is the only defence, and the
  // listing is the thing that can skip a row.
  it('replays a repeated create only while the reservation the key made is still there', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const definition = config({
      name: 'nightly-backup',
      schedule: '0 3 * * *',
      channels: ['ops inbox'],
    })
    const api = apiFor(store)

    await applySync(api, await planSync(api, definition))
    store.hideListing = true

    await applySync(api, await planSync(api, definition))

    expect(store.monitors).toHaveLength(1)

    store.sweepFinalisedKeys()

    await applySync(api, await planSync(api, definition))

    expect(store.monitors).toHaveLength(2)
  })

  it('is still guarded by the listing once the reservation is gone', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const definition = config({
      name: 'nightly-backup',
      schedule: '0 3 * * *',
      channels: ['ops inbox'],
    })
    const api = apiFor(store)

    await applySync(api, await planSync(api, definition))
    store.sweepFinalisedKeys()
    const second = await applySync(api, await planSync(api, definition))

    expect(store.monitors).toHaveLength(1)
    expect(second.created).toEqual([])
    expect(second.unchanged.map((entry) => entry.name)).toEqual(['nightly-backup'])
  })
})

describe('the order a result is read in', () => {
  // A run whose reason and whose deletion are both on screen has to put the reason first: the
  // deletion is the line that reads as success, and reading it first frames the rest as detail.
  it('puts what failed above what was applied', () => {
    const printed = renderResult({
      created: [],
      updated: [],
      deleted: [{ name: 'retired', uuid: '00000000-0000-4000-8000-0000000000c1' }],
      unchanged: [],
      failures: [{ name: 'replacement', action: 'refused', message: 'no channel of this account' }],
      stopped: false,
      pruneSkipped: undefined,
    })
    const lines = printed.split('\n')

    expect(lines.findIndex((line) => line.includes('replacement'))).toBeLessThan(
      lines.findIndex((line) => line.includes('deleted 1')),
    )
  })
})
