import { envVarFor } from '../ping/resolve.js'
import { describeSchedule } from './schedule.js'
import type {
  AlertSuppression,
  AppliedMonitor,
  PlanAction,
  PlanRow,
  RoutedChannel,
  SyncPlan,
  SyncResult,
} from './types.js'

const NOBODY = '(nobody)'

// Two characters, so a marked row and an unmarked one still line up and the marked ones read
// as a column rather than as ragged text.
const SILENT_MARK = '! '

const QUIET_MARK = '  '

const SUPPRESSED: Readonly<Record<AlertSuppression, string>> = {
  paused: '(nobody — paused, and the service does not scan a paused monitor for lateness)',
  snoozed: '(nobody — snoozed, and the service suppresses delivery until the snooze ends)',
}

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
function alertsOf(
  alerts: readonly RoutedChannel[],
  suppression: AlertSuppression | undefined,
): string {
  if (suppression !== undefined) {
    return SUPPRESSED[suppression]
  }

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

  if (row.action === 'conflict' || row.action === 'refused') {
    return `${QUIET_MARK}${row.action.padEnd(ACTION_WIDTH)}${row.name.padEnd(NAME_WIDTH)}${detail}`
  }

  return `${row.alertsNobody ? SILENT_MARK : QUIET_MARK}${row.action.padEnd(ACTION_WIDTH)}${row.name.padEnd(NAME_WIDTH)}${detail} → alerts: ${alertsOf(row.alerts, row.suppression)}`
}

function tallyOf(plan: SyncPlan): string {
  const counted = [
    ...(Object.keys(HEADINGS) as readonly PlanAction[])
      .filter((action) => plan.counts[action] > 0)
      .map((action) => `${plan.counts[action]} ${HEADINGS[action]}`),
    ...(plan.silent > 0 ? [`${plan.silent} alert nobody (!)`] : []),
  ]

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

// What failed is written above what was applied. A run that deleted something prints a line
// that reads as success, and reading that line first frames whatever went wrong as detail.
export function renderResult(result: SyncResult): string {
  const lines: string[] = []

  for (const failure of result.failures) {
    lines.push(`  ${failure.action} ${failure.name} — ${failure.message}`)
  }

  if (result.stopped) {
    lines.push('  stopped before the rest of the plan, because the refusal above is not this monitor’s')
  }

  if (result.pruneSkipped !== undefined) {
    lines.push(`  nothing was deleted — ${result.pruneSkipped}`)
  }

  for (const [what, applied] of [
    ['created', result.created],
    ['updated', result.updated],
    ['deleted', result.deleted],
  ] as const) {
    if (applied.length > 0) {
      lines.push(`  ${what} ${applied.length}: ${namesOf(applied)}`)
    }
  }

  return lines.length === 0 ? '  nothing was changed\n' : `${lines.join('\n')}\n`
}

// What closes the gap between a monitor existing and a job being able to address it. This is
// the one output that carries identifiers, because that is what it is for.
export function envLinesFor(monitors: readonly AppliedMonitor[]): readonly string[] {
  return monitors.map((monitor) => `${envVarFor(monitor.name)}=${monitor.uuid}`)
}
