import { ENVIRONMENT, HELP } from './help.js'

const RUN_HELP = `cronheart run — wrap a command and report what it did

Usage
  cronheart run (--name=<name> | --uuid=<id>) [options] -- <command> [args…]

  Opens with a start check-in, then reports success or failure with the exit status and the
  tail of what the command wrote. Both streams are passed through to the caller as well as
  excerpted, so a redirect in a crontab keeps working.

Options
  --uuid=<id>               the monitor id, written out. This is the form a crontab wants:
                            cron sources no profile, so a name has nothing to resolve
                            through unless the variable is set in the crontab itself.
  --name=<name>             the monitor name, resolved through CRONHEART_<NAME>_UUID.
  --timeout=<duration>      terminate the command after this long. Exit status is then 124,
                            matching timeout(1) — the one case where the exit status is
                            not the command's own, because there is no command status to
                            report. Off unless asked for.
  --kill-after=<duration>   how long a terminated command gets before SIGKILL (default 5s).
                            Longer than a timer can hold means never escalate.
  --output-bytes=<n>        how many bytes of the output tail to send (default fills the
                            body). 0 sends no excerpt at all and inserts no pipe either, so
                            work the command leaves running keeps the streams it started
                            with. --stderr-bytes is the former name and still works.
  --redact=<pattern>        a JavaScript regular expression whose every match is replaced
                            with [redacted] before the excerpt is sent. Repeatable, and
                            applied on top of the built-in ones. A pattern that does not
                            compile is a usage error rather than a silently absent control.

  Run with no terminal — from cron, a timer, a supervisor — the command leads its own
  process group, so SIGINT, SIGTERM and the --timeout deadline reach a shell script's
  children with it. Run from a terminal it does not: a group of its own would cost it the
  terminal a sudo or ssh prompt needs, and the terminal delivers the interrupt itself.
  The escalation to SIGKILL after --kill-after follows either way.

  The command's exit status is passed through. A run that ends in anything but 0 writes its
  summary to stderr, so cron mails it; a run that succeeds writes nothing. A check-in that
  fails writes one line to stderr and changes nothing else, and a server that never answers
  costs the command at most 2s of waiting plus a second of settling. A monitor this wrapper
  cannot use — an empty --uuid where a variable went missing, a stale id, a name behind
  --uuid, both flags at once — is reported the same way and the command still runs,
  unmonitored. Five statuses are the wrapper's own, each where there is no command status to
  report: 64 when the invocation could not be read at all, before anything is spawned; 124
  for --timeout; 127 or 126 when the command cannot be started at all; 70 for this wrapper
  failing in a way it did not anticipate; and 128 plus the signal number for a command a
  signal ended.

Examples
  Every five minutes from a crontab, with the id written out. Cron sets almost no PATH and
  sources no profile, so the binary is named in full and the monitor is addressed directly:

    */5 * * * * /usr/local/bin/cronheart run --uuid=00000000-0000-4000-8000-000000000000 -- /usr/local/bin/cleanup.sh

  The same job by name, with the variable set in the crontab itself, where cron will find it:

    CRONHEART_CLEANUP_UUID=00000000-0000-4000-8000-000000000000
    */5 * * * * /usr/local/bin/cronheart run --name=cleanup -- /usr/local/bin/cleanup.sh

  From a shell or a systemd unit, where the environment already carries the names:

    cronheart run --name=nightly-backup --timeout=2h -- ./backup.sh

${ENVIRONMENT}`

const PING_HELP = `cronheart ping — send one check-in

Usage
  cronheart ping <name-or-id> [--action=heartbeat|start|success|fail] [--body=- | <text>]
                              [--strict] [--verbose] [--redact=<pattern>]

  The monitor is either a name, resolved through CRONHEART_<NAME>_UUID, or an id written out.

Options
  --action=<action>   heartbeat, start, success or fail; heartbeat is what leaving it off
                      sends. Validated here against the closed list the package exports as
                      PING_ACTIONS, because the server reads an action it does not know as
                      a heartbeat — which marks the monitor up.
  --body=<text>       text to send with the check-in. --body=- reads it from standard input.
  --strict            exit 1 when the check-in fails. Off, the exit status is 0 whatever the
                      check-in did, so it cannot break the job around it — an invocation this
                      command could not read at all is still 64.
  --verbose           confirm an accepted check-in on stdout. Off, only a failure is
                      reported, and only on stderr: cron mails whatever a job writes, and
                      one mail per run is how a monitoring tool gets uninstalled. A terminal
                      gets the confirmation without asking, because nobody is being mailed.
  --redact=<pattern>  every match replaced with [redacted] before the body is sent.

Examples
  cronheart ping nightly-backup
  ./backup.sh || cronheart ping nightly-backup --action=fail --body=- < /var/log/backup.err

${ENVIRONMENT}`

const DOCTOR_HELP = `cronheart doctor — report what this environment resolves to

Usage
  cronheart doctor [<name-or-id>]

  Prints the package and runtime, the base URL and where it came from, every monitor
  configured here and which variable answered for it, the result of a real check-in and the
  clock skew against the server. It never prints a monitor id: that id is the whole
  credential on the check-in route.

  What it cannot reach is the alerting side — whether a monitor has a notification channel
  attached, and whether that channel is verified. It says so, rather than leaving a report
  with nothing wrong in it to imply otherwise.

  Exit status is 0 when it found nothing wrong and 1 when it did, and 64 for an invocation
  it could not read at all.

Examples
  cronheart doctor
  cronheart doctor nightly-backup

${ENVIRONMENT}`

const INIT_HELP = `cronheart init — get a monitor, write its variable and prove it works

Usage
  cronheart init [--name=<name>] [--schedule=<schedule>] [--channels=none]
                 [--uuid=<id>] [--env-path=<path>] [--print-env]

  Asks for whatever was not given, writes CRONHEART_<NAME>_UUID to an env file, sends one
  check-in to prove the id works, and then says what a crontab needs that the file cannot
  give it. A pasted id is never echoed back, and a file this command creates is readable by
  its owner alone.

  With CRONHEART_API_KEY set and no --uuid, this creates a monitor on the account — a
  billed resource, counted against the plan's monitor budget — and attaches every channel
  the account has verified, which the REST API does not do by itself. A run that already
  carries the name of a monitor on the account reuses it rather than making a second. With
  no key, nothing is created: the monitor is made in the dashboard and its id pasted here.

Options
  --name=<name>       the monitor name. It is what CRONHEART_<NAME>_UUID is derived from.
  --schedule=<sched>  how often the job is meant to run: a five-field cron expression, one
                      of the seven @ aliases, one of the twelve named schedules, or a
                      duration such as 5m. Only read when a monitor is being created.
  --channels=none     create the monitor with nothing attached, saying in as many words
                      that a monitor nobody is alerted about is what was meant. Without it,
                      an account with no verified channel is refused rather than given a
                      monitor that stays silent when a run goes missing. none is the only
                      value it takes, and it is the word the configuration file takes too.
  --uuid=<id>         the id of a monitor that already exists. Nothing is created for one,
                      whatever the account can do.
  --env-path=<path>   where to write it (default .env). Named --env-path rather than
                      --env-file because Node reads --env-file as one of its own options,
                      wherever on the line it appears.
  --print-env         print the line instead of writing it anywhere.

Examples
  cronheart init
  cronheart init --name=cleanup --schedule='0 3 * * *'
  cronheart init --name=cleanup --print-env

${ENVIRONMENT}`

const SYNC_HELP = `cronheart sync — reconcile a project's monitors against a configuration file

Usage
  cronheart sync [--config=<path>] [--apply | --check] [--prune] [--print-env]
                 [--yes] [--all]

  Reads a file describing the monitors a project should have, compares it against the ones
  the API token's project actually has, and prints what differs. Nothing is changed without
  --apply. It needs CRONHEART_API_KEY, which needs the Starter plan or above — check-ins
  work on every plan, Free included, and none of this is required to be monitored. Monitors are matched by name, which is the whole of the identity available: the
  service enforces no uniqueness on a name and offers no exact-name filter, so a name written
  twice in the file is refused before anything is read, and a name carried by two monitors on
  the service is reported and skipped rather than guessed at.

Options
  --config=<path>   the file to read. Left off, the first of cronheart.config.ts,
                    cronheart.config.mts, cronheart.config.mjs, cronheart.config.js or
                    cronheart.config.json in the working directory is used. Nothing here
                    compiles TypeScript: Node strips the types itself from 22.18 onward and
                    from 22.6 behind --experimental-strip-types; below 22.6 there is no such
                    flag and a .ts config does not load at all. A .mjs or .json file needs
                    neither.
  --apply           make the changes. Without it the run is a report.
  --check           report only, and answer with the exit status: 0 once the account
                    matches the file, 2 while anything differs, and 1 when the run could not
                    answer at all — a refused key, a plan the API is not on, a server that
                    never replied, a file this command would not read, a row the plan refused,
                    a name two monitors on the service both carry. A build that reads
                    anything non-zero as drift reads "the key expired" as "there are changes
                    to make", which is the reading this third status exists to prevent.
  --prune           include monitors the file does not describe. Reported either way; deleted
                    only with --apply --prune and a confirmation, because deleting a monitor
                    destroys its check-in history and nothing can bring it back. With --check
                    it also makes those monitors count as a difference.
  --print-env       print CRONHEART_<NAME>_UUID for every monitor reconciled, which is what a
                    job needs to address one. This is the only output carrying identifiers,
                    and under it stdout carries nothing else — the plan and everything about
                    it go to stderr, so appending the run to .env leaves a file that parses.
  --yes             answer the deletion confirmation in advance.
  --all             show the unchanged rows too. Without it they are counted in the tally
                    and left out of the table, except any that alert nobody.

  The configuration file is only ever read. Nothing writes to it.

  Reads and creates are confined to the one project the API token is scoped to, and no
  response says which project that is — so a monitor in another project of the same account
  is invisible to this command rather than absent.

Configuration
  A TypeScript or JavaScript file default-exports defineMonitors(...):

    import { defineMonitors } from 'cronheart/sync'

    export default defineMonitors([
      { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
      { name: 'sweep',          schedule: { every: '5m' }, channels: 'none' },
    ])

  A JSON file carries the same monitors under a "monitors" key.

  schedule    a five-field cron expression, one of the seven @ aliases, one of the twelve
              named schedules (daily, hourly, every_5_minutes, …), a duration such as 5m or
              90s, or { every: '5m' } / { interval: 300 } / { cron: '…' } / { simple: 'daily' }
              to be explicit.
              A six-field expression is refused here: croner and node-cron accept a leading
              seconds field and this service does not.
  channels    a list of channel labels or identifiers, or 'none' to say in as many words that
              this monitor alerts nobody. Left out — or written as 'unmanaged' — the routing
              is not managed at all and nothing this command sends can change it. An empty
              list is refused, because it is what a defaulted value looks like and it would
              silence the monitor.
  tz          a zone name. Left out, it is not managed.
  graceSeconds  Left out, it is not managed.

  A monitor whose attached channels include none that is verified alerts nobody, and creating
  one is refused unless the file wrote 'none'. Every plan row prints what it alerts.

Examples
  cronheart sync
  cronheart sync --check
  cronheart sync --apply
  cronheart sync --apply --print-env >> .env

${ENVIRONMENT}`

const PAGES: Readonly<Record<string, string>> = {
  run: RUN_HELP,
  ping: PING_HELP,
  doctor: DOCTOR_HELP,
  init: INIT_HELP,
  sync: SYNC_HELP,
}

export function helpFor(command: string | undefined): string {
  return (command === undefined ? undefined : PAGES[command]) ?? HELP
}
