import process from 'node:process'
import { createInterface } from 'node:readline'
import { applySync } from '../sync/apply.js'
import { defineMonitors } from '../sync/define.js'
import { isSyncConfigurationError } from '../sync/errors.js'
import { planSync } from '../sync/plan.js'
import { describeApiRefusal } from '../sync/refusal.js'
import { envLinesFor, renderPlan, renderResult } from '../sync/render.js'
import type { AppliedMonitor, MonitorConfig, SyncPlan, SyncResult } from '../sync/types.js'
import { type ParsedArgs, readFlag, readText, unknownFlags } from './args.js'
import { loadConfigFile } from './config-file.js'
import { EXIT_DRIFT, EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from './exit.js'
import type { Io } from './io.js'
import { openManagementClient } from './managed.js'

const FLAGS = ['config', 'apply', 'check', 'prune', 'print-env', 'yes']

const CONFIRMATION = 'delete'

const NO_TERMINAL_TO_ASK =
  'pruning was asked for and there is no terminal to confirm it on. Deleting a monitor destroys its history, so nothing is deleted without a second answer — pass --yes if this run is meant to give one.'

interface Mode {
  readonly apply: boolean
  readonly check: boolean
  readonly prune: boolean
  readonly printEnv: boolean
  readonly yes: boolean
}

function modeOf(args: ParsedArgs): Mode {
  return {
    apply: readFlag(args, 'apply'),
    check: readFlag(args, 'check'),
    prune: readFlag(args, 'prune'),
    printEnv: readFlag(args, 'print-env'),
    yes: readFlag(args, 'yes'),
  }
}

async function askToDelete(io: Io, names: readonly string[]): Promise<boolean> {
  io.out(
    `  ${names.length} monitor(s) would be deleted: ${names.join(', ')}\n  Deleting a monitor destroys its check-in history, and nothing here can bring it back.\n`,
  )

  if (process.stdin.isTTY !== true) {
    io.err(`cronheart: ${NO_TERMINAL_TO_ASK}\n`)

    return false
  }

  const session = createInterface({ input: process.stdin, output: process.stdout })

  try {
    process.stdout.write(`  Type ${CONFIRMATION} to confirm: `)

    for await (const line of session) {
      return String(line).trim() === CONFIRMATION
    }

    return false
  } finally {
    session.close()
    process.stdin.pause()
  }
}

function knownMonitors(plan: SyncPlan): readonly AppliedMonitor[] {
  return plan.rows.flatMap((row) =>
    row.action === 'unchanged' || row.action === 'update'
      ? [{ name: row.name, uuid: row.uuid }]
      : [],
  )
}

function appliedMonitors(result: SyncResult): readonly AppliedMonitor[] {
  return [...result.created, ...result.updated, ...result.unchanged]
}

function printEnv(io: Io, monitors: readonly AppliedMonitor[], plan: SyncPlan): void {
  for (const line of envLinesFor([...monitors].sort((one, other) => one.name.localeCompare(other.name)))) {
    io.out(`${line}\n`)
  }

  const pending = plan.rows.filter((row) => row.action === 'create').map((row) => row.name)

  if (pending.length > 0) {
    io.err(
      `cronheart: no identifier yet for ${pending.join(', ')} — run again with --apply to create them first\n`,
    )
  }
}

function driftUnder(plan: SyncPlan, mode: Mode): boolean {
  // An orphan is a difference between the configuration and the account, but only a run that
  // asked to prune has claimed the configuration is the whole of it.
  return plan.drift || (mode.prune && plan.counts.orphan > 0)
}

async function reconcile(
  config: MonitorConfig,
  mode: Mode,
  io: Io,
): Promise<number> {
  const opened = openManagementClient()

  if (!opened.ok) {
    io.err(`cronheart: ${opened.problem}\n`)

    return EXIT_PROBLEM
  }

  let plan: SyncPlan

  try {
    plan = await planSync(opened.api, config)
  } catch (error) {
    io.err(`cronheart: ${describeApiRefusal(error, 'cronheart sync')}\n`)

    return EXIT_PROBLEM
  }

  io.out(`cronheart sync — ${mode.apply ? 'applying' : 'nothing was changed'}\n\n`)
  io.out(renderPlan(plan))

  if (!mode.apply) {
    if (mode.check) {
      return plan.faults ? EXIT_PROBLEM : driftUnder(plan, mode) ? EXIT_DRIFT : EXIT_OK
    }

    if (driftUnder(plan, mode)) {
      io.out('  Run again with --apply to make these changes.\n')
    }

    if (mode.printEnv) {
      printEnv(io, knownMonitors(plan), plan)
    }

    return plan.faults ? EXIT_PROBLEM : EXIT_OK
  }

  const orphans = plan.rows.filter((row) => row.action === 'orphan').map((row) => row.name)
  const confirm = mode.yes ? () => true : () => askToDelete(io, orphans)
  const result = await applySync(
    opened.api,
    plan,
    mode.prune && orphans.length > 0 ? { prune: { confirm } } : {},
  )

  io.out('\n')
  io.out(renderResult(result))

  if (mode.printEnv) {
    printEnv(io, appliedMonitors(result), plan)
  }

  return result.failures.length > 0 || (mode.prune && result.deleted.length < orphans.length)
    ? EXIT_PROBLEM
    : EXIT_OK
}

export async function syncCommand(args: ParsedArgs, io: Io): Promise<number> {
  const unknown = unknownFlags(args, FLAGS)

  if (unknown.length > 0) {
    io.err(`cronheart: sync does not take --${unknown.join(', --')}\n`)

    return EXIT_USAGE
  }

  const given = readText(args, 'config')

  if (!given.ok) {
    io.err(`cronheart: ${given.problem}\n`)

    return EXIT_USAGE
  }

  const mode = modeOf(args)

  if (mode.apply && mode.check) {
    io.err(
      'cronheart: --apply makes the changes and --check only reports whether there are any, so a run cannot be both\n',
    )

    return EXIT_USAGE
  }

  const loaded = await loadConfigFile(given.value)

  if (!loaded.ok) {
    io.err(`cronheart: ${loaded.problem}\n`)

    return EXIT_PROBLEM
  }

  // Read and refused before a credential is needed: a name repeated in the file is a fault
  // no account state can resolve, and there is nothing to authenticate for.
  let config: MonitorConfig

  try {
    config = defineMonitors(loaded.value as never)
  } catch (error) {
    io.err(
      `cronheart: ${loaded.path} — ${isSyncConfigurationError(error) ? error.message : String(error)}\n`,
    )

    return EXIT_PROBLEM
  }

  return reconcile(config, mode, io)
}
