import type { SyncPlan } from './types.js'

const EMPTY_CONFIGURATION =
  'this configuration describes no monitors at all, and deleting every monitor of a project is not what a file that describes none most often means — a glob that matched nothing, a half-written file and a list built from an unset variable all arrive here looking exactly like this. Write the monitors this project is meant to have, or delete them where they can be seen.'

const SOMETHING_FAILED =
  'something this run was meant to create or change did not land, and deleting is the half that cannot be undone. Fix what is reported above and run again — the orphans will still be there.'

// Deleting is conditional on the constructive half having landed, because a delete cannot be
// re-run and a create can. One rule, consulted by the command before it offers a confirmation
// and by the apply itself before it sends a request, so the two can never disagree.
export function whyPruningIsUnsafe(plan: SyncPlan, failed: number): string | undefined {
  if (plan.described === 0) {
    return EMPTY_CONFIGURATION
  }

  return failed > 0 ? SOMETHING_FAILED : undefined
}

export function destructionNotice(orphans: readonly string[], onService: number): string {
  return [
    `  ${orphans.length} of the ${onService} monitor(s) this key can see would be deleted: ${orphans.join(', ')}`,
    '  Deleting a monitor destroys its check-in history, and nothing here can bring it back.',
    '',
  ].join('\n')
}
