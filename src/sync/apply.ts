import type { CreateOptions, CronheartApi, RequestOptions } from '../api/types.js'
import { whyPruningIsUnsafe } from './prune.js'
import { describeApiRefusal, refusesEveryCreate, refusesEverything } from './refusal.js'
import type {
  AppliedMonitor,
  ApplyOptions,
  PlanRow,
  SyncFailure,
  SyncPlan,
  SyncResult,
} from './types.js'

const NO_MORE_CREATES =
  'skipped — the refusal above is about this account rather than about one monitor, and it would refuse every remaining create of this run the same way. Nothing was created for this row.'

interface Progress {
  readonly created: AppliedMonitor[]
  readonly updated: AppliedMonitor[]
  readonly deleted: AppliedMonitor[]
  readonly unchanged: AppliedMonitor[]
  readonly failures: SyncFailure[]
  stopped: boolean
  creatingIsPointless: boolean
  pruneSkipped: string | undefined
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

  if (row.action === 'create' && refusesEveryCreate(error)) {
    progress.creatingIsPointless = true
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
    creatingIsPointless: false,
    pruneSkipped: undefined,
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
      if (progress.creatingIsPointless) {
        progress.failures.push({ name: row.name, action: row.action, message: NO_MORE_CREATES })

        continue
      }

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
    pruneSkipped: progress.pruneSkipped,
  }
}

// Deleting a monitor destroys its history and cannot be undone, so it takes three decisions
// that are not the same decision: asking for pruning, the rest of the run having landed, and
// confirming it once the orphans are known. Nothing is asked for when there is nothing to
// delete, and nothing is asked for when there is no longer anything to replace what would go.
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

  if (options.prune === undefined || orphans.length === 0) {
    return
  }

  // A refusal that stopped the run is a recorded failure too, so the rule below covers it.
  const unsafe = whyPruningIsUnsafe(plan, progress.failures.length)

  if (unsafe !== undefined) {
    progress.pruneSkipped = unsafe

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
