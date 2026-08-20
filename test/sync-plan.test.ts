import { describe, expect, it } from 'vitest'
import { planSync } from '../src/sync/plan.js'
import { renderPlan } from '../src/sync/render.js'
import type { PlanRow, PlannedCreate, PlannedUpdate, SyncPlan } from '../src/sync/types.js'
import { channelRow, createMonitorStore, monitorRow } from './support/monitor-store.js'
import { apiFor } from './support/sync-api.js'

const VERIFIED = channelRow({ id: '7', label: 'ops inbox', verified: true })

const UNVERIFIED = channelRow({
  id: '9',
  label: 'pager',
  kind: 'telegram',
  verified: false,
  created_at: '2026-08-02T09:00:00.000Z',
})

function rowFor(plan: SyncPlan, name: string): PlanRow {
  const row = plan.rows.find((entry) => entry.name === name)

  if (row === undefined) {
    throw new Error(`the plan carries no row for ${name}; it carries ${plan.rows.map((entry) => entry.name).join(', ')}`)
  }

  return row
}

// Narrows away the two rows that carry no routing, so reading what a row alerts is a
// question only asked of rows that answer it.
function routedRowFor(plan: SyncPlan, name: string): Exclude<PlanRow, { action: 'conflict' | 'refused' }> {
  const row = rowFor(plan, name)

  if (row.action === 'conflict' || row.action === 'refused') {
    throw new Error(`the row for ${name} is ${row.action}, which carries no routing`)
  }

  return row
}

describe('what a plan does with a name it can and cannot identify', () => {
  it('creates a monitor the service does not carry, and leaves an identical one alone', async () => {
    const store = createMonitorStore([monitorRow()], [VERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
      { name: 'hourly-rollup', schedule: '@hourly', channels: ['ops inbox'] },
    ])

    expect(rowFor(plan, 'nightly-backup').action).toBe('unchanged')
    expect(rowFor(plan, 'hourly-rollup').action).toBe('create')
    expect(plan.drift).toBe(true)
  })

  // Nothing on the service stops two monitors carrying one name, and no listing filter can
  // tell them apart, so there is no correct pick — only a report.
  it('reports a duplicated name as a conflict and plans nothing for it', async () => {
    const store = createMonitorStore(
      [
        monitorRow({ uuid: '00000000-0000-4000-8000-0000000000a1' }),
        monitorRow({ uuid: '00000000-0000-4000-8000-0000000000a2', schedule_expr: '0 4 * * *' }),
      ],
      [VERIFIED],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 5 * * *', channels: ['ops inbox'] },
    ])
    const row = rowFor(plan, 'nightly-backup')

    expect(row.action).toBe('conflict')
    expect(plan.faults).toBe(true)
    expect(renderPlan(plan)).toContain('2')
  })

  it('reports a monitor the configuration does not describe as an orphan, and plans no delete', async () => {
    const store = createMonitorStore([monitorRow({ name: 'retired-job' })], [VERIFIED])
    const plan = await planSync(apiFor(store), [])

    expect(rowFor(plan, 'retired-job').action).toBe('orphan')
    expect(plan.rows.filter((row) => row.action === 'orphan')).toHaveLength(1)
    expect(plan.drift).toBe(false)
  })

  // The listing is ordered by creation time with no tiebreaker, so a walk can hand the same
  // row back twice. Two rows of one uuid must not read as a duplicated name.
  it('reads a row handed back twice by the listing as one monitor, not as a conflict', async () => {
    const store = createMonitorStore([monitorRow()], [VERIFIED])
    const doubled = apiFor(store, {})
    const repeated = createMonitorStore([monitorRow(), monitorRow()], [VERIFIED])

    expect((await planSync(doubled, [{ name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] }])).faults).toBe(false)
    expect(
      rowFor(
        await planSync(apiFor(repeated), [
          { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
        ]),
        'nightly-backup',
      ).action,
    ).toBe('unchanged')
  })
})

describe('the field-level difference a plan reports', () => {
  it('names every field the configuration states and the service disagrees with', async () => {
    const store = createMonitorStore(
      [monitorRow({ schedule_expr: '0 3 * * *', grace_seconds: 60, tz: 'UTC' })],
      [VERIFIED],
    )
    const plan = await planSync(apiFor(store), [
      {
        name: 'nightly-backup',
        schedule: '0 4 * * *',
        tz: 'Europe/Berlin',
        graceSeconds: 120,
        channels: ['ops inbox'],
      },
    ])
    const row = rowFor(plan, 'nightly-backup') as PlannedUpdate

    expect(row.action).toBe('update')
    expect(row.changes.map((change) => change.field).sort()).toEqual([
      'graceSeconds',
      'scheduleExpr',
      'tz',
    ])
    expect(row.changes.find((change) => change.field === 'graceSeconds')).toEqual({
      field: 'graceSeconds',
      from: '60',
      to: '120',
    })
  })

  it('reports no difference for a field the configuration never stated', async () => {
    const store = createMonitorStore(
      [monitorRow({ tz: 'Europe/Berlin', grace_seconds: 900 })],
      [VERIFIED],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])

    expect(rowFor(plan, 'nightly-backup').action).toBe('unchanged')
  })

  it('reads a routing difference by set, since the service returns it sorted by identifier', async () => {
    const store = createMonitorStore(
      [monitorRow({ channel_ids: ['7', '9'] })],
      [VERIFIED, channelRow({ id: '9', label: 'pager', verified: true })],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['pager', 'ops inbox'] },
    ])

    expect(rowFor(plan, 'nightly-backup').action).toBe('unchanged')
  })
})

describe('how a plan names a channel', () => {
  it('takes an identifier as written and a label as the account spells it', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'by-id', schedule: '@daily', channels: ['7'] },
      { name: 'by-number', schedule: '@daily', channels: [7] },
      { name: 'by-label', schedule: '@daily', channels: ['ops inbox'] },
    ])

    for (const name of ['by-id', 'by-number', 'by-label']) {
      expect((rowFor(plan, name) as PlannedCreate).request.channelIds).toEqual(['7'])
    }
  })

  it('refuses a label the account does not carry rather than creating something that alerts nobody', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'a-job', schedule: '@daily', channels: ['ops inbxo'] },
    ])
    const row = rowFor(plan, 'a-job')

    expect(row.action).toBe('refused')
    expect(renderPlan(plan)).toContain('ops inbxo')
  })

  it('refuses a label two channels answer to, because there is no way to tell which was meant', async () => {
    const store = createMonitorStore(
      [],
      [VERIFIED, channelRow({ id: '8', label: 'ops inbox', created_at: '2026-08-03T09:00:00.000Z' })],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'a-job', schedule: '@daily', channels: ['ops inbox'] },
    ])

    expect(rowFor(plan, 'a-job').action).toBe('refused')
  })
})

describe('a monitor that would alert nobody', () => {
  it('is refused on create when every channel it lists is unverified', async () => {
    const store = createMonitorStore([], [UNVERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'a-job', schedule: '@daily', channels: ['pager'] },
    ])
    const row = rowFor(plan, 'a-job')

    expect(row.action).toBe('refused')
    expect(renderPlan(plan)).toContain('alert nobody')
    expect(renderPlan(plan)).toContain('pager')
  })

  it('is refused on create when the configuration says nothing about channels', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const plan = await planSync(apiFor(store), [{ name: 'a-job', schedule: '@daily' }])

    expect(rowFor(plan, 'a-job').action).toBe('refused')
    expect(plan.rows.filter((row) => row.action === 'create')).toHaveLength(0)
  })

  it('is created only when the configuration says so in as many words', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'a-job', schedule: '@daily', channels: 'none' },
    ])

    expect(rowFor(plan, 'a-job').action).toBe('create')
    expect(routedRowFor(plan, 'a-job').alertsNobody).toBe(true)
  })

  // The service skips an attached channel that is not verified, so an existing monitor can
  // already be silent. That is reported, not refused: it is not this run that silenced it.
  it('is reported on a monitor that already exists, without refusing to touch it', async () => {
    const store = createMonitorStore([monitorRow({ channel_ids: ['9'] })], [UNVERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 4 * * *' },
    ])
    const row = routedRowFor(plan, 'nightly-backup')

    expect(row.action).toBe('update')
    expect(row.alertsNobody).toBe(true)
    expect(renderPlan(plan)).toContain('(nobody)')
  })
})

describe('what a plan prints', () => {
  it('names every class of row and counts them', async () => {
    const store = createMonitorStore(
      [monitorRow(), monitorRow({ uuid: '00000000-0000-4000-8000-0000000000b9', name: 'retired' })],
      [VERIFIED],
    )
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 4 * * *', channels: ['ops inbox'] },
      { name: 'fresh-job', schedule: '@hourly', channels: ['ops inbox'] },
    ])
    const printed = renderPlan(plan)

    expect(printed).toContain('create')
    expect(printed).toContain('update')
    expect(printed).toContain('orphan')
    expect(printed).toContain('fresh-job')
    expect(printed).toContain('retired')
  })

  // The identifier is the whole credential on the check-in route, and a plan is what people
  // paste into a pull request.
  it('never prints a monitor identifier', async () => {
    const store = createMonitorStore([monitorRow()], [VERIFIED])
    const plan = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 4 * * *', channels: ['ops inbox'] },
    ])

    expect(renderPlan(plan)).not.toContain('00000000-0000-4000-8000-0000000000a1')
  })

  it('says which project it reconciled against cannot be known from here', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const plan = await planSync(apiFor(store), [])

    expect(plan.scopeNotice).toContain('project')
    expect(renderPlan(plan)).toContain('project')
  })
})
