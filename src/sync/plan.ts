import type {
  Channel,
  CreateMonitorRequest,
  CronheartApi,
  Monitor,
  RequestOptions,
  UpdateMonitorRequest,
} from '../api/types.js'
import { defineMonitors } from './define.js'
import { idempotencyKeyFor } from './key.js'
import { resolveChannels, routingKeys, verifiedAmong } from './routing.js'
import type {
  AlertSuppression,
  DefinedMonitor,
  FieldChange,
  PlanAction,
  PlanOptions,
  PlanRow,
  ResolvedRouting,
  RoutedChannel,
  SyncConfigInput,
  SyncPlan,
} from './types.js'

// Reads and creates are confined to the project the token resolves to, and no response says
// which project that is, so this is the honest statement of what was reconciled.
export const SCOPE_NOTICE =
  'Reconciled against the one project this API token is scoped to. No response names which project that is, so this cannot either — a monitor in another project of the same account is invisible here, not absent.'

const SAY_SO_INSTEAD =
  "Attach a channel this account has verified, or write channels: 'none' to say that a monitor nobody is alerted about is what you meant."

// The two ways to reach a monitor nothing ever alerts about read very differently, and
// neither is visible in what the service would answer. Silence a configuration did not ask
// for is refused; silence that was already there when the run started is only reported.
function nobodyReason(routing: ResolvedRouting, channels: readonly Channel[]): string {
  if (routing.mode !== 'listed') {
    return `would alert nobody: this configuration says nothing about channels, and creating a monitor over the API attaches none — unlike the form in the dashboard, which pre-selects them. ${SAY_SO_INSTEAD}`
  }

  const named = channels
    .filter((channel) => routing.ids.includes(channel.id))
    .map((channel) => channel.label)

  return `would alert nobody: ${named.join(', ')} ${named.length === 1 ? 'is named here but is not verified on this account' : 'are named here and none of them is verified on this account'}, and the service skips an unverified channel when it sends an alert. ${SAY_SO_INSTEAD}`
}

const CONFLICT_REASON =
  'monitors on the service carry this name. A name is all sync has to tell them apart and the service enforces no uniqueness on one, so there is no way to know which was meant'

function changed(field: string, from: unknown, to: unknown): FieldChange | undefined {
  return String(from) === String(to)
    ? undefined
    : { field, from: String(from), to: String(to) }
}

function sameSet(one: readonly string[], other: readonly string[]): boolean {
  return one.length === other.length && one.every((id) => other.includes(id))
}

function silentIn(rows: readonly PlanRow[]): number {
  return rows.filter((row) => row.action !== 'conflict' && row.action !== 'refused' && row.alertsNobody)
    .length
}

function countsOf(rows: readonly PlanRow[]): Readonly<Record<PlanAction, number>> {
  const counts: Record<PlanAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    orphan: 0,
    conflict: 0,
    refused: 0,
  }

  for (const row of rows) {
    counts[row.action] += 1
  }

  return counts
}

function suppressionOf(monitor: Monitor): AlertSuppression | undefined {
  if (monitor.status === 'paused') {
    return 'paused'
  }

  const until = monitor.snoozedUntil === null ? Number.NaN : Date.parse(monitor.snoozedUntil)

  return Number.isNaN(until) || until <= Date.now() ? undefined : 'snoozed'
}

async function everyMonitor(api: CronheartApi, options: RequestOptions): Promise<Monitor[]> {
  const collected: Monitor[] = []

  // The listing orders by creation time with no tiebreaker, so a deep walk can repeat a row
  // or miss one. The walk drops repeats by identifier; a miss is not fixable from here,
  // which is why a create carries a key derived from what it would create.
  for await (const monitor of api.monitors.iterate(options)) {
    collected.push(monitor)
  }

  return collected
}

function resolvedRoutingFor(
  monitor: DefinedMonitor,
  channels: readonly Channel[],
): ResolvedRouting | { readonly refusal: string } {
  if (monitor.routing.mode !== 'listed') {
    return { mode: monitor.routing.mode }
  }

  const found = resolveChannels(channels, monitor.routing.references)

  return found.ok ? { mode: 'listed', ids: found.ids } : { refusal: found.reason }
}

function alertsFor(
  routing: ResolvedRouting,
  channels: readonly Channel[],
  attached: readonly string[],
): readonly RoutedChannel[] {
  if (routing.mode === 'none') {
    return []
  }

  return verifiedAmong(channels, routing.mode === 'listed' ? routing.ids : attached)
}

function nobodyIsAlerted(
  alerts: readonly RoutedChannel[],
  suppression: AlertSuppression | undefined,
): boolean {
  return alerts.length === 0 || suppression !== undefined
}

function createRequestFor(monitor: DefinedMonitor, routing: ResolvedRouting): CreateMonitorRequest {
  return {
    name: monitor.name,
    scheduleKind: monitor.scheduleKind,
    scheduleExpr: monitor.scheduleExpr,
    ...(monitor.tz === undefined ? {} : { tz: monitor.tz }),
    ...(monitor.graceSeconds === undefined ? {} : { graceSeconds: monitor.graceSeconds }),
    ...routingKeys(routing),
  }
}

function differencesFrom(
  monitor: DefinedMonitor,
  existing: Monitor,
  routing: ResolvedRouting,
): readonly FieldChange[] {
  const attached = existing.channels.map((channel) => channel.id)

  return [
    changed('scheduleKind', existing.scheduleKind, monitor.scheduleKind),
    changed('scheduleExpr', existing.scheduleExpr, monitor.scheduleExpr),
    monitor.tz === undefined ? undefined : changed('tz', existing.tz, monitor.tz),
    monitor.graceSeconds === undefined
      ? undefined
      : changed('graceSeconds', existing.graceSeconds, monitor.graceSeconds),
    // A field the configuration never states is a field sync does not manage: comparing one
    // would report a difference nobody asked to close, and closing it would change a value
    // nobody wrote down.
    routing.mode === 'unmanaged' || sameSet(routing.mode === 'none' ? [] : routing.ids, attached)
      ? undefined
      : changed(
          'channels',
          attached.join(', ') || '(nobody)',
          (routing.mode === 'none' ? [] : routing.ids).join(', ') || '(nobody)',
        ),
  ].filter((change): change is FieldChange => change !== undefined)
}

function updateRequestFor(
  monitor: DefinedMonitor,
  changes: readonly FieldChange[],
  routing: ResolvedRouting,
): UpdateMonitorRequest {
  const touched = new Set(changes.map((change) => change.field))

  return {
    ...(touched.has('scheduleKind') ? { scheduleKind: monitor.scheduleKind } : {}),
    ...(touched.has('scheduleExpr') ? { scheduleExpr: monitor.scheduleExpr } : {}),
    ...(monitor.tz !== undefined && touched.has('tz') ? { tz: monitor.tz } : {}),
    ...(monitor.graceSeconds !== undefined && touched.has('graceSeconds')
      ? { graceSeconds: monitor.graceSeconds }
      : {}),
    ...(touched.has('channels') ? routingKeys(routing) : {}),
  }
}

async function rowFor(
  monitor: DefinedMonitor,
  found: readonly Monitor[],
  channels: readonly Channel[],
): Promise<PlanRow> {
  const routing = resolvedRoutingFor(monitor, channels)

  if ('refusal' in routing) {
    return { action: 'refused', name: monitor.name, reason: routing.refusal }
  }

  if (found.length > 1) {
    return {
      action: 'conflict',
      name: monitor.name,
      count: found.length,
      reason: `${found.length} ${CONFLICT_REASON}`,
    }
  }

  const existing = found[0]
  const attached = existing === undefined ? [] : existing.channels.map((channel) => channel.id)
  const alerts = alertsFor(routing, channels, attached)

  // A configuration that names channels and resolves to nothing verified is this run asking
  // for a monitor nobody is alerted about, whether the monitor exists yet or not. Only a
  // create is refused for saying nothing, because on an existing monitor that silence is not
  // this run's doing and closing it would move a field nobody wrote down.
  if (
    alerts.length === 0 &&
    (routing.mode === 'listed' || (existing === undefined && routing.mode === 'unmanaged'))
  ) {
    return { action: 'refused', name: monitor.name, reason: nobodyReason(routing, channels) }
  }

  if (existing === undefined) {
    const request = createRequestFor(monitor, routing)

    return {
      action: 'create',
      name: monitor.name,
      alerts,
      alertsNobody: nobodyIsAlerted(alerts, undefined),
      suppression: undefined,
      request,
      idempotencyKey: await idempotencyKeyFor(request),
    }
  }

  const suppression = suppressionOf(existing)
  const changes = differencesFrom(monitor, existing, routing)

  if (changes.length === 0) {
    return {
      action: 'unchanged',
      name: monitor.name,
      uuid: existing.uuid,
      alerts,
      alertsNobody: nobodyIsAlerted(alerts, suppression),
      suppression,
    }
  }

  return {
    action: 'update',
    name: monitor.name,
    uuid: existing.uuid,
    changes,
    alerts,
    alertsNobody: nobodyIsAlerted(alerts, suppression),
    suppression,
    request: updateRequestFor(monitor, changes, routing),
  }
}

export async function planSync(
  api: CronheartApi,
  input: SyncConfigInput,
  options: PlanOptions = {},
): Promise<SyncPlan> {
  const config = defineMonitors(input)
  const request: RequestOptions = {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const channels = (await api.channels.list(request)).data
  const existing = await everyMonitor(api, request)
  const described = new Set(config.monitors.map((monitor) => monitor.name))
  const rows: PlanRow[] = []

  for (const monitor of config.monitors) {
    rows.push(
      await rowFor(
        monitor,
        existing.filter((candidate) => candidate.name === monitor.name),
        channels,
      ),
    )
  }

  for (const monitor of existing) {
    if (described.has(monitor.name)) {
      continue
    }

    const attached = monitor.channels.map((channel) => channel.id)
    const alerts = verifiedAmong(channels, attached)
    const suppression = suppressionOf(monitor)

    rows.push({
      action: 'orphan',
      name: monitor.name,
      uuid: monitor.uuid,
      alerts,
      alertsNobody: nobodyIsAlerted(alerts, suppression),
      suppression,
    })
  }

  const counts = countsOf(rows)

  return {
    rows,
    counts,
    described: config.monitors.length,
    onService: existing.length,
    silent: silentIn(rows),
    drift: counts.create > 0 || counts.update > 0,
    faults: counts.conflict > 0 || counts.refused > 0,
    scopeNotice: SCOPE_NOTICE,
  }
}
