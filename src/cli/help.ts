export const ENVIRONMENT = `Environment
  CRONHEART_URL             base URL (default https://cronheart.com)
  CRONHEART_<NAME>_UUID     the monitor id for <NAME>
  CRONHEART_API_KEY         REST API token (not needed for check-ins)
  CRONHEART_TIMEOUT_MS      per-check-in budget
  CRONHEART_RETRIES         attempts beyond the first
  CRONHEART_DISABLED        set to stop every check-in
  CRONHEART_REDACT          redaction patterns, one per line, applied like --redact. One
                            that does not compile withholds the excerpt rather than
                            stopping the command
`

export const HELP = `cronheart — check-in monitoring for scheduled jobs

Usage
  cronheart run [--name=<name> | --uuid=<id>] [options] -- <command> [args…]
  cronheart ping <name-or-id> [options]
  cronheart doctor [<name-or-id>]
  cronheart init [options]
  cronheart sync [--config=<path>] [--apply | --check] [--prune] [--print-env] [--yes]

Commands
  run       wrap a command: open with a start check-in, then report what it did
  ping      send one check-in
  doctor    report what this environment resolves to, and check in for real
  init      create or record a monitor and verify it
  sync      reconcile the monitors of a project against a configuration file

  cronheart <command> --help   the options that command takes, with examples

${ENVIRONMENT}`
