import { envVarFor } from '../ping/resolve.js'
import { describeSchedule } from './schedule.js'
import type {
  AppliedMonitor,
  PlanAction,
  PlanRow,
  RoutedChannel,
  SyncPlan,
  SyncResult,
} from './types.js'

const NOBODY = '(nobody)'

const ACTION_WIDTH = 10

const NAME_WIDTH = 26

const HEADINGS: Readonly<Record<PlanAction, string>> = {
  create: 'to create',
  update: 'to update',
  unchanged: 'unchanged',
  orphan: 'orphan',
  conflict: 'conflict',
  refused: 'refused',
}

const ORPHAN_NOTE =
  'on the service and absent from this configuration. Reported only — deleting a monitor destroys its history, so it takes --apply --prune and a confirmation'

// The identifier is the whole credential on the check-in route, and a plan is a thing people
// paste into a pull request. Names carry the report; identifiers go out under --print-env
// alone, where asking for them is the point.
function alertsOf(alerts: readonly RoutedChannel[]): string {
  return alerts.length === 0
    ? NOBODY
    : alerts.map((channel) => `${channel.label} (${channel.kind})`).join(', ')
}

function detailOf(row: PlanRow): string {
  if (row.action === 'create') {
    return describeSchedule(row.request.scheduleKind, row.request.scheduleExpr)
  }

  if (row.action === 'update') {
    return row.changes
      .map((change) => `${change.field} ${change.from} → ${change.to}`)
      .join(', ')
  }

  if (row.action === 'orphan') {
    return ORPHAN_NOTE
  }

  if (row.action === 'conflict' || row.action === 'refused') {
    return row.reason
  }

  return ''
}

function lineFor(row: PlanRow): string {
  const detail = detailOf(row)
  const alerts =
    row.action === 'conflict' || row.action === 'refused'
      ? ''
      : ` → alerts: ${alertsOf(row.alerts)}`

  return `  ${row.action.padEnd(ACTION_WIDTH)}${row.name.padEnd(NAME_WIDTH)}${detail}${alerts}`
}

function tallyOf(plan: SyncPlan): string {
  const counted = (Object.keys(HEADINGS) as readonly PlanAction[])
    .filter((action) => plan.counts[action] > 0)
    .map((action) => `${plan.counts[action]} ${HEADINGS[action]}`)

  return counted.length === 0 ? '  nothing to reconcile' : `  ${counted.join(', ')}`
}

export function renderPlan(plan: SyncPlan): string {
  return [
    ...plan.rows.map(lineFor),
    '',
    tallyOf(plan),
    `  ${plan.scopeNotice}`,
    '',
  ].join('\n')
}

function namesOf(applied: readonly AppliedMonitor[]): string {
  return applied.map((entry) => entry.name).join(', ')
}

export function renderResult(result: SyncResult): string {
  const lines: string[] = []

  for (const [what, applied] of [
    ['created', result.created],
    ['updated', result.updated],
    ['deleted', result.deleted],
  ] as const) {
    if (applied.length > 0) {
      lines.push(`  ${what} ${applied.length}: ${namesOf(applied)}`)
    }
  }

  for (const failure of result.failures) {
    lines.push(`  ${failure.action} ${failure.name} — ${failure.message}`)
  }

  if (result.stopped) {
    lines.push('  stopped before the rest of the plan, because the refusal above is not this monitor’s')
  }

  return lines.length === 0 ? '  nothing was changed\n' : `${lines.join('\n')}\n`
}

// What closes the gap between a monitor existing and a job being able to address it. This is
// the one output that carries identifiers, because that is what it is for.
export function envLinesFor(monitors: readonly AppliedMonitor[]): readonly string[] {
  return monitors.map((monitor) => `${envVarFor(monitor.name)}=${monitor.uuid}`)
}
