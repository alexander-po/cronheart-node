import { ENVIRONMENT, HELP } from './help.js'

const RUN_HELP = `cronheart run — wrap a command and report what it did

Usage
  cronheart run [--name=<name> | --uuid=<id>] [options] -- <command> [args…]

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

  The command's exit status is passed through. A run that ends in anything but 0 writes its
  summary to stderr, so cron mails it; a run that succeeds writes nothing. A check-in that
  fails writes one line to stderr and changes nothing else, and a server that never answers
  costs the command at most 2s. Three statuses are the wrapper's own, each where there is no
  command status to report: 64 for a usage error, before anything is spawned; 124 for
  --timeout; and 127 or 126 when the command cannot be started at all.

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
  cronheart ping <name-or-id> [--action=start|success|fail] [--body=- | <text>]
                              [--strict] [--verbose] [--redact=<pattern>]

  The monitor is either a name, resolved through CRONHEART_<NAME>_UUID, or an id written out.

Options
  --action=<action>   start, success or fail. Left off, the check-in is a plain heartbeat.
                      Validated here against a closed list, because the server reads an
                      action it does not know as a heartbeat — which marks the monitor up.
  --body=<text>       text to send with the check-in. --body=- reads it from standard input.
  --strict            exit 1 when the check-in fails. Off, the exit status is 0 whatever
                      happened, so a check-in cannot break the job around it.
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

  Exit status is 0 when it found nothing wrong and 1 when it did.

Examples
  cronheart doctor
  cronheart doctor nightly-backup

${ENVIRONMENT}`

const INIT_HELP = `cronheart init — write the variable for a monitor and verify it

Usage
  cronheart init [--name=<name>] [--uuid=<id>] [--env-path=<path>] [--print-env]

  Asks for whatever was not given, writes CRONHEART_<NAME>_UUID to an env file, sends one
  check-in to prove the id works, and then says what a crontab needs that the file cannot
  give it. A pasted id is never echoed back, and a file this command creates is readable by
  its owner alone.

Options
  --env-path=<path>   where to write it (default .env). Named --env-path rather than
                      --env-file because Node reads --env-file as one of its own options,
                      wherever on the line it appears.
  --print-env         print the line instead of writing it anywhere.

Examples
  cronheart init
  cronheart init --name=cleanup --print-env

${ENVIRONMENT}`

const PAGES: Readonly<Record<string, string>> = {
  run: RUN_HELP,
  ping: PING_HELP,
  doctor: DOCTOR_HELP,
  init: INIT_HELP,
}

export function helpFor(command: string | undefined): string {
  return (command === undefined ? undefined : PAGES[command]) ?? HELP
}
