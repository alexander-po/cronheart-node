export const HELP = `cronheart — check-in monitoring for scheduled jobs

Usage
  cronheart run [--name=<name> | --uuid=<id>] [options] -- <command> [args…]
  cronheart ping <name-or-id> [--action=start|success|fail] [--body=- | <text>] [--strict]
  cronheart doctor [<name-or-id>]
  cronheart init [--name=<name>] [--uuid=<id>] [--env-path=<path>] [--print-env]

run
  Wraps a command: opens with a start check-in, then reports success or failure with the
  exit status and the tail of stderr as the body. stderr is passed through to the parent
  as well as excerpted, so a redirect in a crontab keeps working.

  --timeout=<duration>      kill the command after this long. Exit status is then 124,
                            matching timeout(1) — the one case where the exit status is
                            not the command's own, because there is no command status to
                            report. Off unless asked for.
  --kill-after=<duration>   how long a terminated command gets before SIGKILL (default 5s)
  --stderr-bytes=<n>        how many bytes of the stderr tail to send (default fills the body)

  SIGINT and SIGTERM are forwarded to the command and escalate to SIGKILL after
  --kill-after; the check-in body says the run was signalled.

  Exit status is the command's own. A check-in that fails writes one line to stderr and
  changes nothing else. The exceptions are 64 for a usage error, which happens before
  anything is spawned; 124 for --timeout; and 127 or 126 when the command cannot be
  started at all.

ping
  Sends one check-in. --body=- reads the body from standard input. The exit status is 0
  even when the check-in fails, so a check-in cannot break the job around it; --strict
  turns a failed check-in into exit 1.

doctor
  Reports the configuration it resolved, which variable answered for each monitor, the
  result of a real check-in and the clock skew against the server. Works with or without
  an API key.

init
  Writes the environment variable for a monitor and verifies it with a check-in.
  The destination is --env-path rather than --env-file because Node reads --env-file
  as one of its own options, wherever it appears on the line.

Environment
  CRONHEART_URL             base URL (default https://cronheart.com)
  CRONHEART_<NAME>_UUID     the monitor id for <NAME>
  CRONHEART_API_KEY         REST API token (not needed for check-ins)
  CRONHEART_TIMEOUT_MS      per-check-in budget
  CRONHEART_RETRIES         attempts beyond the first
  CRONHEART_DISABLED        set to stop every check-in
`
