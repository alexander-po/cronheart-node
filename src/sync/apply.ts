import type { CreateOptions, CronheartApi, RequestOptions } from '../api/types.js'
import { describeApiRefusal, refusesEverything } from './refusal.js'
import type {
  AppliedMonitor,
  ApplyOptions,
  PlanRow,
  SyncFailure,
  SyncPlan,
  SyncResult,
} from './types.js'

interface Progress {
  readonly created: AppliedMonitor[]
  readonly updated: AppliedMonitor[]
  readonly deleted: AppliedMonitor[]
  readonly unchanged: AppliedMonitor[]
  readonly failures: SyncFailure[]
  stopped: boolean
}

function record(progress: Progress, row: PlanRow, error: unknown): void {
  progress.failures.push({
    name: row.name,
    action: row.action,
    message: describeApiRefusal(error, 'cronheart sync'),
  })

  if (refusesEverything(error)) {
    progress.stopped = true
  }
}

function unresolved(rows: readonly PlanRow[], progress: Progress): void {
  for (const row of rows) {
    if (row.action === 'conflict' || row.action === 'refused') {
      progress.failures.push({ name: row.name, action: row.action, message: row.reason })
    }
  }
}

function requestOptions(options: ApplyOptions): RequestOptions {
  return {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}

// Every request this makes comes off a row the plan built, and a row the plan refused is a
// different action carrying no request at all — so there is no path from a refusal to a
// create, and none from a monitor the plan never saw.
export async function applySync(
  api: CronheartApi,
  plan: SyncPlan,
  options: ApplyOptions = {},
): Promise<SyncResult> {
  const request = requestOptions(options)
  const progress: Progress = {
    created: [],
    updated: [],
    deleted: [],
    unchanged: [],
    failures: [],
    stopped: false,
  }

  unresolved(plan.rows, progress)

  for (const row of plan.rows) {
    if (progress.stopped) {
      break
    }

    if (row.action === 'unchanged') {
      progress.unchanged.push({ name: row.name, uuid: row.uuid })
      continue
    }

    if (row.action === 'create') {
      const create: CreateOptions = { ...request, idempotencyKey: row.idempotencyKey }

      try {
        const made = await api.monitors.create(row.request, create)
        progress.created.push({ name: made.name, uuid: made.uuid })
      } catch (error) {
        record(progress, row, error)
      }

      continue
    }

    if (row.action === 'update') {
      try {
        const changed = await api.monitors.update(row.uuid, row.request, request)
        progress.updated.push({ name: changed.name, uuid: changed.uuid })
      } catch (error) {
        record(progress, row, error)
      }
    }
  }

  await prune(api, plan, options, progress, request)

  return {
    created: progress.created,
    updated: progress.updated,
    deleted: progress.deleted,
    unchanged: progress.unchanged,
    failures: progress.failures,
    stopped: progress.stopped,
  }
}

// Deleting a monitor destroys its history and cannot be undone, so it takes two decisions
// that are not the same decision: asking for pruning, and confirming it once the orphans are
// known. Nothing is asked for when there is nothing to delete.
async function prune(
  api: CronheartApi,
  plan: SyncPlan,
  options: ApplyOptions,
  progress: Progress,
  request: RequestOptions,
): Promise<void> {
  const orphans = plan.rows.filter((row): row is Extract<PlanRow, { action: 'orphan' }> =>
    row.action === 'orphan',
  )

  if (options.prune === undefined || orphans.length === 0 || progress.stopped) {
    return
  }

  if ((await options.prune.confirm()) !== true) {
    return
  }

  for (const row of orphans) {
    if (progress.stopped) {
      return
    }

    try {
      await api.monitors.delete(row.uuid, request)
      progress.deleted.push({ name: row.name, uuid: row.uuid })
    } catch (error) {
      record(progress, row, error)
    }
  }
}
