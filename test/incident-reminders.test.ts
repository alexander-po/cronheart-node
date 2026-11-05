import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ApiHydrationError, ApiInvalidRequestError } from '../src/api/errors.js'
import { idempotencyKeyFor } from '../src/sync/key.js'
import { defineMonitors } from '../src/sync/define.js'
import { SyncConfigurationError } from '../src/sync/errors.js'
import { applySync } from '../src/sync/apply.js'
import { planSync } from '../src/sync/plan.js'
import type { PlannedCreate, PlannedUpdate } from '../src/sync/types.js'
import { MONITOR_JSON, MONITOR_UUID, apiWith } from './support/api-recorder.js'
import { channelRow, createMonitorStore, monitorRow } from './support/monitor-store.js'
import { apiFor, bodiesSentTo } from './support/sync-api.js'

const CREATE = { name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' } as const

const VERIFIED = channelRow({ id: '7', label: 'ops inbox', verified: true })

function sentBody(request: { readonly body?: unknown } | undefined): Record<string, unknown> {
  return JSON.parse(String(request?.body)) as Record<string, unknown>
}

describe('the monitor a client reads', () => {
  it('carries whether reminders are on', async () => {
    const off = apiWith({ json: MONITOR_JSON })
    const on = apiWith({ json: { ...MONITOR_JSON, incident_reminders: true } })

    expect((await off.api.monitors.get(MONITOR_UUID)).incidentReminders).toBe(false)
    expect((await on.api.monitors.get(MONITOR_UUID)).incidentReminders).toBe(true)
  })

  it('reports a value that is not a boolean as a failure of its own', async () => {
    const { api } = apiWith({ json: { ...MONITOR_JSON, incident_reminders: 'yes' } })

    await expect(api.monitors.get(MONITOR_UUID)).rejects.toBeInstanceOf(ApiHydrationError)
  })

  it('refuses a monitor that carries no such key, as it does for the other required keys', async () => {
    const { incident_reminders: _omitted, ...without } = MONITOR_JSON
    const { api } = apiWith({ json: without })

    await expect(api.monitors.get(MONITOR_UUID)).rejects.toBeInstanceOf(ApiHydrationError)
  })
})

describe('the requests that set it', () => {
  it('writes the wire name on a create, and sends none when the caller left it out', async () => {
    const { api, recorder } = apiWith({ status: 201, json: MONITOR_JSON })

    await api.monitors.create({ ...CREATE, incidentReminders: true })
    await api.monitors.create(CREATE)

    expect(sentBody(recorder.requests[0])['incident_reminders']).toBe(true)
    expect(Object.keys(sentBody(recorder.requests[1]))).not.toContain('incident_reminders')
  })

  it('sends it on an update only when asked, false included', async () => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await api.monitors.update(MONITOR_UUID, { name: 'renamed' })
    await api.monitors.update(MONITOR_UUID, { incidentReminders: false })
    await api.monitors.update(MONITOR_UUID, { incidentReminders: true })

    expect(sentBody(recorder.requests[0])).toEqual({ name: 'renamed' })
    expect(sentBody(recorder.requests[1])).toEqual({ incident_reminders: false })
    expect(sentBody(recorder.requests[2])).toEqual({ incident_reminders: true })
  })

  it.each([1, 'true', null, 0])('refuses %j before a request exists', async (bad) => {
    const { api, recorder } = apiWith({ json: MONITOR_JSON })

    await expect(
      api.monitors.update(MONITOR_UUID, { incidentReminders: bad as never }),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    await expect(
      api.monitors.create({ ...CREATE, incidentReminders: bad as never }),
    ).rejects.toBeInstanceOf(ApiInvalidRequestError)
    expect(recorder.requests).toEqual([])
  })
})

describe('what a configuration says about it', () => {
  it('leaves it unmanaged when not written, and keeps it when written', () => {
    const quiet = defineMonitors([{ name: 'a-job', schedule: '@daily', channels: 'none' }])
    const loud = defineMonitors([
      { name: 'a-job', schedule: '@daily', channels: 'none', incidentReminders: false },
    ])

    expect(quiet.monitors[0]?.incidentReminders).toBeUndefined()
    expect(loud.monitors[0]?.incidentReminders).toBe(false)
  })

  it('refuses a value that is not a boolean as a configuration error naming the monitor and the field', () => {
    let failure: unknown

    try {
      defineMonitors([
        { name: 'a-job', schedule: '@daily', channels: 'none', incidentReminders: 'on' as never },
      ])
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(SyncConfigurationError)
    expect(String((failure as Error).message)).toContain('a-job')
    expect(String((failure as Error).message)).toContain('incidentReminders')
  })

  it('creates a monitor with it on, and a create without it sends no key', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(api, [
      { name: 'one', schedule: '@daily', channels: ['ops inbox'], incidentReminders: true },
      { name: 'two', schedule: '@hourly', channels: ['ops inbox'] },
    ])

    await applySync(api, plan)

    const bodies = bodiesSentTo(store, 'POST') as Record<string, unknown>[]
    expect(bodies.map((body) => body['incident_reminders'])).toEqual([true, undefined])
    expect((plan.rows[0] as PlannedCreate).request.incidentReminders).toBe(true)
  })

  it('mints a different create key for each of on, off and not stated, and keeps the earlier one when not stated', async () => {
    const base = { name: 'one', scheduleKind: 'cron', scheduleExpr: '0 3 * * *' } as const
    const keys = [
      await idempotencyKeyFor({ ...base, incidentReminders: true }),
      await idempotencyKeyFor({ ...base, incidentReminders: false }),
      await idempotencyKeyFor(base),
    ]
    const earlier = JSON.stringify(['one', 'cron', '0 3 * * *', null, null, []])

    expect(new Set(keys).size).toBe(3)
    expect(keys[2]).toBe(`sync-${createHash('sha256').update(earlier).digest('hex')}`)
  })

  it('plans an update that sends only the setting, and reports it as a change', async () => {
    const store = createMonitorStore([monitorRow()], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(api, [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'], incidentReminders: true },
    ])
    const row = plan.rows[0] as PlannedUpdate

    expect(row.changes).toEqual([{ field: 'incidentReminders', from: 'false', to: 'true' }])
    expect(row.request).toEqual({ incidentReminders: true })

    await applySync(api, plan)

    expect(bodiesSentTo(store, 'PATCH')).toEqual([{ incident_reminders: true }])
    expect(store.monitors[0]?.incident_reminders).toBe(true)
  })

  it('turns it off through an update, sending false rather than nothing', async () => {
    const store = createMonitorStore([monitorRow({ incident_reminders: true })], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(api, [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'], incidentReminders: false },
    ])
    const row = plan.rows[0] as PlannedUpdate

    expect(row.changes).toEqual([{ field: 'incidentReminders', from: 'true', to: 'false' }])
    expect(row.request).toEqual({ incidentReminders: false })

    await applySync(api, plan)

    expect(bodiesSentTo(store, 'PATCH')).toEqual([{ incident_reminders: false }])
    expect(store.monitors[0]?.incident_reminders).toBe(false)
  })

  it('creates a monitor with it stated off, sending false', async () => {
    const store = createMonitorStore([], [VERIFIED])
    const api = apiFor(store)
    const plan = await planSync(api, [
      { name: 'one', schedule: '@daily', channels: ['ops inbox'], incidentReminders: false },
    ])

    await applySync(api, plan)

    expect((bodiesSentTo(store, 'POST') as Record<string, unknown>[])[0]?.['incident_reminders']).toBe(false)
  })

  it('stores the value it checked, so a getter that changes its answer cannot slip a later one through', () => {
    let reads = 0
    const definition = {
      name: 'a-job',
      schedule: '@daily',
      channels: 'none',
      get incidentReminders() {
        reads += 1
        return reads < 2 ? true : ('\u001b[31mred' as never)
      },
    } as const

    expect(defineMonitors([definition]).monitors[0]?.incidentReminders).toBe(true)
  })

  it('reports no difference when it matches, or when the configuration never states it', async () => {
    const store = createMonitorStore([monitorRow({ incident_reminders: true })], [VERIFIED])
    const same = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'], incidentReminders: true },
    ])
    const silent = await planSync(apiFor(store), [
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
    ])

    expect(same.rows[0]?.action).toBe('unchanged')
    expect(silent.rows[0]?.action).toBe('unchanged')
  })
})
