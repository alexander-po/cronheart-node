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
cronheart run --help                              # options and examples for one command
```

`run` wraps a command. It opens with a `start` check-in, then reports success
or failure with the exit status and the tail of the command's stderr as the
body — and **exits with the command's own exit status**. A check-in that fails
writes one line to stderr and changes nothing else: a monitoring outage must
never turn a working job into a failing one.

A run that ends in anything but `0` also writes its summary to **stderr**, so
cron mails it the way it would have mailed the unwrapped command's own error; a
run that succeeds writes nothing at all. A wrapper may be silent on success. It
may not be silent on failure, because failure is the entire reason cron mails
you.

Both streams are teed rather than captured — every byte still reaches the
parent, so a crontab's `2>> log` keeps working while the last `--output-bytes`
of the combined output ride along with the check-in. stdout is in there because
most Python, PHP and `make` output reports its failure there, and an excerpt
that watched only stderr would send `exited with status 1` and nothing else.
(`--stderr-bytes` is the former name of that flag and still works.) The excerpt
is cut on a character boundary even when the operating system split a character
across two reads. The tee honours the parent's backpressure, so a command
writing faster than the parent reads is paced exactly as it would be writing to
that parent directly.

A job's output is the most credential-dense thing it produces, so the excerpt
is redacted **before** any of it is cut — the wrapper's byte budget, the ring
that bounds its memory and the body cap all run afterwards, and can therefore
only ever split a `[redacted]` marker in half rather than strip the anchor off
a secret and leave the secret behind. Tokens, `Authorization` values,
credentials inside a URL and `*_PASSWORD` / `*_TOKEN` / `*_KEY` assignments are
recognised out of the box; `--redact=<pattern>` (repeatable) and
`CRONHEART_REDACT` add more, and `--output-bytes=0` sends no excerpt at all —
and inserts no pipe on either stream, so anything the command leaves running
keeps the caller's own stdout and stderr. A pattern that does not compile is
never a control that quietly protects nothing: on the command line it is a
usage error, while in
`CRONHEART_REDACT` — one typo in which would otherwise stop every wrapped job
on the machine — the command runs and the excerpt is withheld entirely, said
so on stderr. The command being wrapped is not given `CRONHEART_API_KEY`:
check-ins need no key, so there is nothing to trade away.

Three exit statuses are the wrapper's own rather than the command's, and each
is a case where there is no command status to report: `64` for a usage error,
which happens before anything is spawned; `124` when `--timeout` expires,
matching `timeout(1)`; and `127` / `126` when the command cannot be started at
all. A command that has already exited can no longer time out, whatever is
still holding its output streams open.

Run with no terminal — from cron, a systemd timer, a supervisor — the command
leads its own process group, so `SIGINT`, `SIGTERM` and the `--timeout`
deadline are delivered to that whole group and a shell script's children go
with it. Run **from a terminal** it does not: a process group of its own means
`setsid`, which costs the command the controlling terminal that a `sudo` or
`ssh` password prompt needs, and the terminal has already delivered the
interrupt to the whole foreground group anyway — so the wrapper does not relay
it a second time, which many tools read as *abort now*. Escalation to `SIGKILL`
follows after `--kill-after` (5s by default, and never when it is longer than a
timer can hold). The check-in body says the run was signalled.

A server that never answers cannot hold the command up: the terminal check-in
and its flush share one 2 s budget, after which the status already in hand is
returned and whatever is in flight is abandoned. An interrupt arriving during
that budget does the same rather than replacing the status with `130`.

`ping` sends one check-in and exits `0` even when the check-in fails, for the
same reason `run` does; `--strict` turns a failed check-in into exit `1`. It is
**silent on a check-in that worked** and writes to stderr on one that did not,
the way `curl -fsS` behaves — one mail per run from a per-minute crontab is how
a monitoring tool gets uninstalled. At a terminal, or under `--verbose`, the
confirmation is printed. `--action` is validated against a closed set of
literals before a URL exists, because the server maps an action it does not
recognise to a plain heartbeat — which marks the monitor *up*.

Whatever the outcome, what gets printed is the sentence the client wrote for
it — *no monitor id for "cleanup", so nothing was sent. Set
CRONHEART_CLEANUP_UUID…* — rather than the outcome token behind it.

`doctor` reports the configuration it resolved, which environment variable
answered for each monitor, the result of a real check-in and the clock skew
against the server. It never prints a monitor id: that id is the whole
credential for the check-in route. It also names what it did **not** check —
whether the monitor has a notification channel attached and whether that channel
is verified — because a report with nothing wrong in it would otherwise read as
reassurance about alerting that nothing here established.

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
*/5 * * * * /usr/local/bin/cronheart run --uuid=00000000-0000-4000-8000-000000000000 -- /usr/local/bin/cleanup.sh
```

Two things that line is deliberate about. The id is written **inline**, because
`--name` resolves through an environment variable and cron sources no profile —
a `--name` entry in a crontab runs the job, tells the monitor nothing and exits
`0`. And both paths are absolute, because cron's `PATH` is typically
`/usr/bin:/bin`, which a global install under a Node version manager is not on.

To use a name instead, set the variable in the crontab itself, where cron will
pass it to the job:

```cron
CRONHEART_CLEANUP_UUID=00000000-0000-4000-8000-000000000000
*/5 * * * * /usr/local/bin/cronheart run --name=cleanup -- /usr/local/bin/cleanup.sh
```

Install it globally and pin the version. `npx` re-resolves the package on
every run and needs a warm cache at cron time, which for a monitoring wrapper
is an availability regression — use it to try the tool, not to run one.

## Management API

`cronheart/api` wraps the REST API: monitors, notification channels and the
account's plan and budget. It needs an API key, which needs the **Starter plan
or above** — check-ins work on every plan, Free included, and nothing in this
section is required to be monitored.

```ts
import { createCronheartApi, isCronheartApiError } from 'cronheart/api'

const api = createCronheartApi({ apiKey: process.env.CRONHEART_API_KEY })

const monitor = await api.monitors.create({
  name: 'nightly-backup',
  scheduleKind: 'cron',
  scheduleExpr: '0 3 * * *',
  channelIds: ['12'],
})

for await (const one of api.monitors.iterate()) {
  console.log(one.name, one.status)
}
```

`api.monitors.*`, `api.channels.*` and `api.account.get()`. The key is read
from `CRONHEART_API_KEY` when you pass none. Vocabularies — schedule kinds,
channel kinds — are typed open in both directions, so a value read off a
monitor can be written straight back; a member the service does not have is
refused by name before a request exists rather than at compile time.

**It always throws.** The check-in client never does; this one runs in CLIs and
admin scripts, where a silent failure is worse than a loud one. Every failure —
a refused request, a connection that never opened, a body that is not JSON, a
response this client cannot read — arrives as a `CronheartApiError`, so one
`catch` is exhaustive. Discriminate on `error.kind`
(`'authentication' | 'plan-restriction' | 'not-found' | 'validation' |
'rate-limit' | 'conflict' | 'transport' | …`) rather than on `instanceof`:
two copies of this package in one dependency tree have different classes, and
`instanceof` answers false across them without saying so. `isCronheartApiError`
is a brand check that survives that, and it narrows to `AnyCronheartApiError`,
a union whose members each declare their own `kind` — so the field that kind
carries is reachable straight after the check:

```ts
try {
  await api.monitors.create(request)
} catch (error) {
  if (!isCronheartApiError(error)) throw error

  if (error.kind === 'validation') console.error(Object.keys(error.errors))
  else if (error.kind === 'rate-limit') console.error(error.retryAfterSeconds)
  else if (error.kind === 'plan-restriction') console.error(error.upgradeUrl)
  else if (error.kind === 'transport') console.error(error.reason)
  else throw error
}
```

`error.reason` is the only way to tell a timeout from a dead socket.
`error.group` is the coarser cut: `'response'` is everything the server
refused, and `'configuration'`, `'invalid-request'`, `'transport'` and
`'hydration'` are the four ways a request failed without one.

The key is validated when the client is built, so a value read out of a file
with its newline still attached fails at process start rather than inside a
running job. It travels in the `Authorization` header and nowhere else — never
a query string — and this package refuses to send it over plain `http` to
anything but loopback. It appears in no message, no log line, no `toJSON` and
no error `cause`. A separate sweep asserts that across every route the built
client exposes — the route list is read off the client, not maintained by hand
— under thirteen ways a request can fail, and a deliberately-leaking control
proves the assertion can fail. The fault matrix carries three of those routes,
where it also asserts that no monitor identifier reaches a message: a request
is reported as `GET /api/v1/monitors/{uuid}`, never with the identifier in it,
because that identifier is the check-in capability.

### Paging has three shapes and they are not interchangeable

| Listing | Shape | This package |
| --- | --- | --- |
| monitors, alerts | offset | `list()` for one page, `iterate()` for an async iterator |
| pings | opaque cursor | `pings()` for one page, `iteratePings()` for an async iterator |
| channels | **none at all** | `channels.list()` returns the whole set — and is deliberately not an iterator |

The channels listing reads no pagination parameters and echoes none back, so a
generic offset walk pointed at it cannot even tell one request's worth from the
whole set, and never terminates.

The two offset listings order by creation time **with no tiebreaker**, and
creation time is stored to the whole second. Rows created in the same second
have no defined relative order, so a deep walk can repeat a row or skip one.
`iterate()` drops repeats by identifier; it cannot recover a skip. Do not build
anything that depends on two walks of an unchanged account agreeing.

### Two more things the wire does that will surprise you

**Channel identifiers read as strings and are written as integers**, and a
value that is not numeric is coerced to zero server-side — which then fails as
"unknown channel 0" rather than naming what you sent. Pass them as the strings
the listing gave you; this package converts at the boundary and refuses a
non-numeric one before the request exists. Never parse one into a number: they
are 64-bit and a JavaScript number loses the far end of the range.

**A monitor's `channels[]` carries no `verified` flag**, and a channel's
`config` comes back with the destination masked. So "does this monitor alert
anybody?" needs a second call to `api.channels.list()` and an intersection, and
a reconciler can compare ownership and labels but never destinations. The
monitor payload also carries no project identity, though reads and creates are
scoped to the key's project — so a caller cannot tell which project it just
reconciled.

### Retries

Reads and updates are retried on a connection failure or a 5xx, within one
overall time budget. `4xx` is never retried and `429` deliberately is not, so
you can read the guidance it came with. **A create is retried only when you
pass an `idempotencyKey`**, and it is the one request that waits between
attempts: the key reserves a row for 60 seconds, so a retry sent immediately is
refused as a conflict while the resource was in fact created. A `409` on a
create says so — read the resource back before deciding it was not created.
Rotations and channel tests are never retried at all. `CRONHEART_RETRIES` is
read here too, and capped at 5 the same way — one bound, shared with the
check-in transport, which neither client can raise. An idempotency key that is
blank counts as no key at all, because that is what the service does with one:
a blank key would otherwise turn retries on and create a second monitor.

`cronheart/sync` will reconcile a declared set of monitors against the server.
Both are separate entry points so the ping path stays small in production
bundles.

_`cronheart/sync` is not implemented yet._

## Runtime support

Node 22 or newer, zero runtime dependencies. The root entry imports nothing
from `node:`, which is what keeps non-Node runtimes on the table; the CLI is
the only entry point that reaches for Node built-ins, and a test enforces the
split. The ping entry is about 6 KB gzipped once your bundler has minified it
— that is what your users download, so it is what the budget is measured on —
and CI fails on a regression past 7,168 bytes. The unminified figure, about
8.7 KB gzipped, is reported alongside it so a regression in either is
visible. The CLI is bundled apart from the
library entries so that it cannot pull the ping path into a shared chunk and
charge every consumer for import glue it has no use for. The management client
is bundled apart for the same reason, and for the same measured reason: sharing
a chunk with the root cost the ping entry 266 bytes.

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
