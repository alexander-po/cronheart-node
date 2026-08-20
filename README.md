# cronheart

Cron job monitoring and dead man's switch for Node.js and TypeScript —
heartbeat check-ins that alert you when a scheduled job stops running. Works
with node-cron, croner, cron, node-schedule, BullMQ, NestJS schedule, plain
crontab and systemd timers, plus a CLI wrapper for any command. Official SDK
for [cronheart.com](https://cronheart.com).

[![CI](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Pre-release.** The ping path and the CLI are implemented; the management
> API, the reconciler and the scheduler adapters are not, and nothing is
> published to npm yet. Every section below marked _Not implemented yet_ has no
> behaviour behind it — this README documents only what ships.

## Why

Uptime monitors don't catch the silent failure mode: a backup that stopped
running a month ago, an invoice job that didn't fire on the 1st, an ETL
pipeline whose timer was renamed. A per-job dead man's switch does — the job
checks in, and you hear about it when it stops.

## Install

_Not published yet._ The package name on npm is `cronheart`.

## Quick start

Create the monitor in the dashboard, put its id in the environment, and wrap
the job. A monitor called `nightly-backup` resolves from
`CRONHEART_NIGHTLY_BACKUP_UUID`; a raw id works anywhere a name does.

```ts
import { checkIn, checkInWith, startRun, withMonitor } from 'cronheart'

// Bracket a run: start, then success or failure, with the elapsed time.
// The job's own error is rethrown untouched.
await withMonitor('nightly-backup', runBackup)

// Or check in when the work is already done.
await checkIn('nightly-backup')

// Or hold the two halves yourself.
const run = startRun('nightly-backup')
await run.success()

// Or build a thunk once, at wiring time, and hand it to a timer.
const beat = checkInWith('heartbeat', { action: 'success' })
setInterval(beat, 60_000)
```

`createPingClient(options)` gives the same surface with explicit configuration
— a base URL, an id map, timeouts, redaction patterns and a result callback —
for codebases that would rather not read the environment.

`withMonitor` is `startRun` with the job handed in, so both brackets behave
identically. The start check-in is dispatched and **not** awaited: a job begins
immediately, whatever the network is doing, and a stalled start never holds it.
The terminal check-in is awaited, and reports the job's own elapsed time.
Options passed to `startRun` cover its terminal check-in too; options passed to
`run.success()` or `run.fail(error)` layer on top of them.

## Never breaks the job

A check-in never throws and never rejects, whatever the network does. Every
path returns a `PingResult` instead:

```ts
const result = await checkIn('nightly-backup')

result.outcome // 'accepted' | 'duplicate' | 'paused' | 'not-found' | …
result.ok      // the server recorded the check-in
result.sent    // a request actually left the process
```

A cancellation you asked for is reported as its own outcome: aborting a
`signal` you passed in gives `aborted`, never `timeout`, so a shutdown does not
read as a deadline nobody set. And when the budget runs out after the server
has already answered with a 5xx, that answer is what comes back — `server-error`
with its status — rather than a timeout that hides which of the two happened.

Configuration mistakes are loud rather than silent: an id that resolves to
nothing, and the `CRONHEART_DISABLED` kill switch, each produce their own
outcome plus one `console.warn` per process naming the variable to set. Pass
`onResult` to replace that warner with your own logger. Names, however, are
validated at wiring time: `createPingClient`, `monitors.define`,
`monitors.resolve` and `checkInWith` throw on an unresolvable name, so a
typo fails the deploy rather than going quiet at 3am.

The guarantee is mechanical, not aspirational. One `safely()` chokepoint covers
name resolution, URL construction, option reading and body encoding as well as
the request; a source guard fails the build on a network call, a `throw` or a
rejected promise outside the layer that owns them; and a fault matrix runs every
entry point against every way a transport can misbehave, every way a deployment
can be misconfigured, and every way the calling program can hand in something
hostile — an options object whose getter throws, an error whose `stack` accessor
throws, a result sink that rejects, a response whose body never arrives. Each
case asserts that the job's return value comes back by identity, that its
exception propagates unchanged, that overhead stays bounded, that no promise is
left unhandled and that no identifier reaches a log line. A deliberately unsafe
control proves the matrix can go red.

## Configuration

| Variable | Default | Does |
| --- | --- | --- |
| `CRONHEART_<NAME>_UUID` | — | the id for the monitor called `<name>` |
| `CRONHEART_URL` | `https://cronheart.com` | base URL |
| `CRONHEART_TIMEOUT_MS` | `5000` | total budget for one check-in, across retries |
| `CRONHEART_RETRIES` | `2` | retries after the first attempt, capped at 5; server errors and network failures |
| `CRONHEART_DISABLED` | unset | `1` stops every check-in, loudly |
| `CRONHEART_REDACT` | unset | extra redaction patterns for the CLI, one regular expression per line |

`CRON_MONITOR_*` is accepted for all of these, permanently and without a
deprecation warning.

A check-in retries a failed connection and a 5xx, never a 4xx — `404`, `410`
and `429` are answers rather than failures. The count is capped at 5 however it
is configured, attempts are spaced by at least 50 ms, and the whole sequence,
delays included, is spent inside `CRONHEART_TIMEOUT_MS`. The base URL is
validated when the client is built: a query string, a fragment or a scheme that
is not http(s) is refused there, because the ping path is appended to it and a
check-in would otherwise land on the site root and be recorded as accepted. A
credential in the URL is refused too, and so is plain `http:` to anywhere but
loopback — a check-in body carries a job's own output. A
redirect is never followed either: the specification turns a redirected POST
into a GET without a body, which would drop the job's output on the way.

## Schedulers

Adapters instrument the scheduler library rather than each job's call site, so
jobs added later are covered without another edit. Planned subpaths:
`cronheart/croner`, `cronheart/cron`, `cronheart/node-cron`,
`cronheart/node-schedule`, `cronheart/bullmq`, `cronheart/nestjs`.

_Not implemented yet._

## CLI

```bash
cronheart init                                    # paste a monitor id, write the env var, verify it
cronheart run --name=nightly-backup -- ./backup.sh
cronheart ping nightly-backup --action=fail --body=-
cronheart doctor
```

`run` wraps a command. It opens with a `start` check-in, then reports success
or failure with the exit status and the tail of the command's stderr as the
body — and **exits with the command's own exit status**. A check-in that fails
writes one line to stderr and changes nothing else: a monitoring outage must
never turn a working job into a failing one.

stderr is teed rather than captured — every byte still reaches the parent, so a
crontab's `2>> log` keeps working while the last `--stderr-bytes` of it ride
along with the check-in. The excerpt is cut on a character boundary even when
the operating system split a character across two reads.

A job's stderr is the most credential-dense stream it produces, so the excerpt
is redacted **before** any of it is cut — the wrapper's byte budget, the ring
that bounds its memory and the body cap all run afterwards, and can therefore
only ever split a `[redacted]` marker in half rather than strip the anchor off
a secret and leave the secret behind. Tokens, `Authorization` values,
credentials inside a URL and `*_PASSWORD` / `*_TOKEN` / `*_KEY` assignments are
recognised out of the box; `--redact=<pattern>` (repeatable) and
`CRONHEART_REDACT` add more, and `--stderr-bytes=0` sends no excerpt at all. A
pattern that does not compile is a usage error, not a control that quietly
protects nothing. The command being wrapped is not given `CRONHEART_API_KEY`:
check-ins need no key, so there is nothing to trade away.

Three exit statuses are the wrapper's own rather than the command's, and each
is a case where there is no command status to report: `64` for a usage error,
which happens before anything is spawned; `124` when `--timeout` expires,
matching `timeout(1)`; and `127` / `126` when the command cannot be started at
all. `SIGINT` and `SIGTERM` are forwarded to the command and escalate to
`SIGKILL` after `--kill-after` (5s by default); the check-in body says the run
was signalled.

`ping` sends one check-in and exits `0` even when the check-in fails, for the
same reason `run` does; `--strict` turns a failed check-in into exit `1`.
`--action` is validated against a closed set of literals before a URL exists,
because the server maps an action it does not recognise to a plain heartbeat —
which marks the monitor *up*.

`doctor` reports the configuration it resolved, which environment variable
answered for each monitor, the result of a real check-in and the clock skew
against the server. It never prints a monitor id: that id is the whole
credential for the check-in route.

`init` writes `CRONHEART_<NAME>_UUID` for a monitor and verifies it with a
check-in. Creating the monitor from the command line needs the REST API, which
is Starter-and-above, so on the free path `init` links to the dashboard and
takes a pasted id instead. Its destination flag is `--env-path` rather than
`--env-file`, because Node reads `--env-file` as one of its own options
wherever it appears on the line.

## Not a Node project?

The CLI wraps any command, so a crontab entry, a systemd timer or a shell
script checks in without a Node codebase around it.

```cron
*/5 * * * * cronheart run --name=cleanup -- /usr/local/bin/cleanup.sh
```

Install it globally and pin the version. `npx` re-resolves the package on
every run and needs a warm cache at cron time, which for a monitoring wrapper
is an availability regression — use it to try the tool, not to run one.

## Management API

`cronheart/api` will wrap the REST API — creating, reading and reconciling
monitors and notification channels — and `cronheart/sync` will reconcile a
declared set of monitors against the server. Both are separate entry points so
the ping path stays small in production bundles.

_Not implemented yet._

## Runtime support

Node 22 or newer, zero runtime dependencies. The root entry imports nothing
from `node:`, which is what keeps non-Node runtimes on the table; the CLI is
the only entry point that reaches for Node built-ins, and a test enforces the
split. The ping entry is 8.4 KB gzipped before your bundler's minifier sees
it, and CI fails on a regression past 8.5 KB. The CLI is bundled apart from the
library entries so that it cannot pull the ping path into a shared chunk and
charge every consumer for import glue it has no use for.

## Development

Everything runs inside Docker — no Node or pnpm on the host:

```bash
make install   # pnpm install
make build     # bundle dist/ (ESM + CJS + .d.ts)
make test      # Vitest
make lint      # tsc, fixture consumer tsc, source guard, publint, attw, size
make vectors   # the language-neutral conformance vectors
make matrix    # the fault matrix and its negative control
make check     # the full gate, including the ESM/CJS consumption smoke
make shell     # interactive shell in the container
```

`make help` lists every target. CI runs the same checks natively across a Node
version matrix.

## License

MIT — see [LICENSE](LICENSE).
