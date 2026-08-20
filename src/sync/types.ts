import type {
  AbortSignalLike,
  CreateMonitorRequest,
  ScheduleKind,
  SimpleSchedule,
  UpdateMonitorRequest,
} from '../api/types.js'

export type ChannelReference = string | number

export type ScheduleInput =
  | string
  | { readonly cron: string }
  | { readonly simple: SimpleSchedule }
  | { readonly interval: string | number }
  | { readonly every: string | number }

// Three states, written down rather than inferred, because the service reads this field as a
// wholesale replacement when it is present and leaves the routing alone when it is absent.
// Silence is 'unmanaged'; emptying a monitor's routing takes the word 'none'.
export type RoutingInput = readonly ChannelReference[] | 'none' | 'unmanaged'

export interface MonitorDefinition {
  readonly name: string
  readonly schedule: ScheduleInput
  readonly tz?: string | undefined
  readonly graceSeconds?: number | undefined
  readonly channels?: RoutingInput | undefined
}

export interface MonitorConfigInput {
  readonly monitors: readonly MonitorDefinition[]
}

export type SyncConfigInput = MonitorConfig | MonitorConfigInput | readonly MonitorDefinition[]

export type RoutingMode = 'listed' | 'none' | 'unmanaged'

export type DefinedRouting =
  | { readonly mode: 'listed'; readonly references: readonly ChannelReference[] }
  | { readonly mode: 'none' }
  | { readonly mode: 'unmanaged' }

export type ResolvedRouting =
  | { readonly mode: 'listed'; readonly ids: readonly string[] }
  | { readonly mode: 'none' }
  | { readonly mode: 'unmanaged' }

export interface DefinedMonitor {
  readonly name: string
  readonly scheduleKind: ScheduleKind
  readonly scheduleExpr: string
  // Absent means the configuration says nothing about the field, so nothing sync sends can
  // move it. A field is managed by being written down, never by carrying a default here.
  readonly tz: string | undefined
  readonly graceSeconds: number | undefined
  readonly routing: DefinedRouting
}

export interface MonitorConfig {
  readonly monitors: readonly DefinedMonitor[]
}

// Neither is a managed field, and both stop an alert regardless of routing: the lateness scan
// skips a paused monitor outright, and a live snooze suppresses delivery until it ends.
export type AlertSuppression = 'paused' | 'snoozed'

export interface RoutedChannel {
  readonly id: string
  readonly kind: string
  readonly label: string
}

export interface FieldChange {
  readonly field: string
  readonly from: string
  readonly to: string
}

export interface PlannedCreate {
  readonly action: 'create'
  readonly name: string
  readonly alerts: readonly RoutedChannel[]
  readonly alertsNobody: boolean
  readonly suppression: AlertSuppression | undefined
  readonly request: CreateMonitorRequest
  readonly idempotencyKey: string
}

export interface PlannedUpdate {
  readonly action: 'update'
  readonly name: string
  readonly uuid: string
  readonly changes: readonly FieldChange[]
  readonly alerts: readonly RoutedChannel[]
  readonly alertsNobody: boolean
  readonly suppression: AlertSuppression | undefined
  readonly request: UpdateMonitorRequest
}

export interface PlannedUnchanged {
  readonly action: 'unchanged'
  readonly name: string
  readonly uuid: string
  readonly alerts: readonly RoutedChannel[]
  readonly alertsNobody: boolean
  readonly suppression: AlertSuppression | undefined
}

export interface PlannedOrphan {
  readonly action: 'orphan'
  readonly name: string
  readonly uuid: string
  readonly alerts: readonly RoutedChannel[]
  readonly alertsNobody: boolean
  readonly suppression: AlertSuppression | undefined
}

export interface PlannedConflict {
  readonly action: 'conflict'
  readonly name: string
  readonly count: number
  readonly reason: string
}

export interface PlannedRefusal {
  readonly action: 'refused'
  readonly name: string
  readonly reason: string
}

export type PlanRow =
  | PlannedCreate
  | PlannedUpdate
  | PlannedUnchanged
  | PlannedOrphan
  | PlannedConflict
  | PlannedRefusal

export type PlanAction = PlanRow['action']

export interface SyncPlan {
  readonly rows: readonly PlanRow[]
  readonly counts: Readonly<Record<PlanAction, number>>
  // Zero described is not an instruction to empty the account — far more often it is a glob
  // that matched nothing — so pruning reads this rather than the orphan count, which cannot
  // tell the two apart.
  readonly described: number
  readonly onService: number
  readonly silent: number
  // Changes the configuration asks for. Orphans are not counted here: reporting one is not
  // the same as asking for it to be deleted, and only --prune makes that a difference.
  readonly drift: boolean
  readonly faults: boolean
  readonly scopeNotice: string
}

export interface PlanOptions {
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignalLike | undefined
}

export interface PruneConfirmation {
  confirm(): boolean | PromiseLike<boolean>
}

export interface ApplyOptions {
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignalLike | undefined
  // Deleting a monitor destroys its history, so pruning is not a flag that can be defaulted
  // true: it is an object carrying the confirmation, and no confirmation means no delete.
  readonly prune?: PruneConfirmation | undefined
}

export interface AppliedMonitor {
  readonly name: string
  readonly uuid: string
}

export interface SyncFailure {
  readonly name: string
  readonly action: PlanAction
  readonly message: string
}

export interface SyncResult {
  readonly created: readonly AppliedMonitor[]
  readonly updated: readonly AppliedMonitor[]
  readonly deleted: readonly AppliedMonitor[]
  readonly unchanged: readonly AppliedMonitor[]
  readonly failures: readonly SyncFailure[]
  // True when a refusal that would refuse every remaining request ended the run early.
  readonly stopped: boolean
  // Why pruning was asked for and not done.
  readonly pruneSkipped: string | undefined
}
