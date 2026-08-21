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

// Never the same word as an empty routing list: a row can carry both, and they are different
// facts about it.
const NOBODY = 'nobody'

// Two characters, so a marked row and an unmarked one still line up and the marked ones read
// as a column rather than as ragged text.
const SILENT_MARK = '! '

const QUIET_MARK = '  '

const SUPPRESSED: Readonly<Record<AlertSuppression, string>> = {
  paused: `${NOBODY} — paused, and the service does not scan a paused monitor for lateness`,
  snoozed: `${NOBODY} — snoozed, and the service suppresses delivery until the snooze ends`,
}

const ACTION_WIDTH = 10

const FIELD_WIDTH = 14

const DETAIL_INDENT = '    '

const HEADINGS: Readonly<Record<PlanAction, string>> = {
  create: 'to create',
  update: 'to update',
  unchanged: 'unchanged',
  orphan: 'orphan',
  conflict: 'conflict',
  refused: 'refused',
}

const ORPHAN_NOTE = 'An orphan is on the service and absent from this configuration.'

const ORPHAN_TAKES =
  'Deleting one destroys its check-in history and nothing here can bring it back, so it takes --apply --prune and a confirmation.'

const UNCHANGED_HIDDEN =
  'Unchanged rows are not shown; pass --all for the whole plan. A row nobody is alerted about is shown either way.'

export interface PlanView {
  readonly hideUnchanged?: boolean | undefined
  // Set by a run that is about to put the deletion notice, which says all of this at length.
  readonly pruning?: boolean | undefined
}

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

function field(name: string, value: string): string {
  return `${DETAIL_INDENT}${name.padEnd(FIELD_WIDTH)}${value}`
}

function detailsOf(row: PlanRow): readonly string[] {
  if (row.action === 'conflict' || row.action === 'refused') {
    return [`${DETAIL_INDENT}${row.reason}`]
  }

  const alerts = field('alerts', alertsOf(row.alerts, row.suppression))

  if (row.action === 'create') {
    return [
      field('schedule', describeSchedule(row.request.scheduleKind, row.request.scheduleExpr)),
      alerts,
    ]
  }

  if (row.action === 'update') {
    return [
      ...row.changes.map((change) => field(change.field, `${change.from} → ${change.to}`)),
      alerts,
    ]
  }

  return [alerts]
}

function linesFor(row: PlanRow): readonly string[] {
  const marked = row.action !== 'conflict' && row.action !== 'refused' && row.alertsNobody

  return [
    `${marked ? SILENT_MARK : QUIET_MARK}${row.action.padEnd(ACTION_WIDTH)}${row.name}`,
    ...detailsOf(row),
  ]
}

function hidden(row: PlanRow, view: PlanView): boolean {
  return view.hideUnchanged === true && row.action === 'unchanged' && !row.alertsNobody
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

// Said once about the whole plan rather than once per row. The scope notice rides with the
// orphans, because reading one as absent rather than as invisible is the mistake it prevents.
function notesOn(plan: SyncPlan, view: PlanView, anyHidden: boolean): readonly string[] {
  return [
    ...(anyHidden ? [`  ${UNCHANGED_HIDDEN}`] : []),
    ...(plan.counts.orphan === 0
      ? []
      : [
          `  ${ORPHAN_NOTE}${view.pruning === true ? '' : ` ${ORPHAN_TAKES}`}`,
          `  ${plan.scopeNotice}`,
        ]),
  ]
}

export function renderPlan(plan: SyncPlan, view: PlanView = {}): string {
  const shown = plan.rows.filter((row) => !hidden(row, view))

  return [
    ...shown.flatMap(linesFor),
    '',
    tallyOf(plan),
    ...notesOn(plan, view, shown.length < plan.rows.length),
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

  if (result.pruneDeclined) {
    lines.push(
      '  nothing was deleted — the confirmation was declined, so every monitor reported as an orphan is still there',
    )
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
