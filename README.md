# cronheart

Cron job monitoring and dead man's switch for Node.js and TypeScript —
heartbeat check-ins that alert you when a scheduled job stops running. Works
with node-cron, croner, cron, node-schedule, BullMQ, NestJS schedule, plain
crontab and systemd timers, plus a CLI wrapper for any command. Official SDK
for [cronheart.com](https://cronheart.com).

[![npm](https://img.shields.io/npm/v/cronheart.svg)](https://www.npmjs.com/package/cronheart)
[![CI](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#versioning-public-api-and-node-support)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why

Uptime monitors don't catch the silent failure mode: a backup that stopped
running a month ago, an invoice job that didn't fire on the 1st, an ETL
pipeline whose timer was renamed. A per-job dead man's switch does — the job
checks in, and you hear about it when it stops.

## Install

```bash
npm install cronheart
```

`pnpm add cronheart`, `yarn add cronheart` and `bun add cronheart` do the same.

Zero runtime dependencies and no install script — nothing is fetched or
executed on your behalf at install time. Every scheduler this package adapts is
an **optional** peer imported for its types only, so installing it adds nothing
you are not already running. Node 22 or newer; see
[Versioning, public API and Node support](#versioning-public-api-and-node-support).

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
const beat = checkInWith('nightly-backup', { action: 'success' })
setInterval(beat, 60_000)
```

`createPingClient(options)` gives the same brackets with explicit configuration
— a base URL, an id map, timeouts, redaction patterns and a result callback —
for codebases that would rather not read the environment. Its own methods are
`ping`, `start`, `success` and `fail` alongside `withMonitor`, `startRun`,
`checkInWith`, `flush` and a `monitors` registry.

Rather than creating the monitors by hand, a project on a paid plan can write
them in a file and have them reconciled — see [Declarative sync](#declarative-sync).

`withMonitor` is `startRun` with the job handed in, so both brackets behave
identically. The start check-in is dispatched and **not** awaited: a job begins
immediately, whatever the network is doing, and a stalled start never holds it.
The terminal check-in is awaited, and reports the job's own elapsed time.
Options passed to `startRun` cover its terminal check-in too; options passed to
`run.success()` or `run.fail(error)` layer on top of them.

## Replacing a hand-rolled check-in

If a job of yours already checks in, you probably have a version of this: a
module someone wrote in twenty minutes, which then stayed. This is the real
before-picture — the first project migrated onto this package was running these
lines, with the names changed.

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAMonitorId(value: string): boolean {
  return UUID.test(value)
}

export async function checksIn(id: string, log: Logger): Promise<void> {
  if (!isAMonitorId(id)) throw new Error(`not a monitor id: ${id}`)

  try {
    const response = await fetch(`https://cronheart.com/ping/${id}/success`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    })

    if (!response.ok) log.warn(`check-in failed: HTTP ${response.status}`)
  } catch (error) {
    log.warn(`check-in failed: ${String(error)}`)
  }
}
```

Twelve lines and a regular expression. All of it, replaced:

```ts
import { createPingClient } from 'cronheart'

const cronheart = createPingClient()

export const checksIn = (name: string) => cronheart.success(name)
```

The logging goes with the rest of it: a check-in that did not land writes its
own sentence, once per process per cause per monitor. Routing those into your
own logger instead is `onResult` — which takes over the whole reporting job, the
once-per-cause ledger included, so a per-minute job is back to a line per tick
unless the sink says otherwise:

```ts
import { createPingClient, describePingResult } from 'cronheart'

createPingClient({
  onResult: (result) => {
    if (!result.ok) log.warn(describePingResult(result))
  },
})
```

`isMonitorId` is exported too, so a configuration loader that validated ids at
boot keeps doing that without carrying its own copy of the pattern.

The line count is not the argument. What the twelve lines above cannot do is:

- **Retry.** A refused connection and a 5xx are the two commonest ways a
  check-in fails, and a single attempt reports both as final. This client
  retries both — and never a `404`, `410` or `429`, which are answers rather
  than failures.
- **Bound the whole thing.** `AbortSignal.timeout` covers the `fetch` call, not
  the response read: a transport that ignores the signal — precisely the case a
  deadline exists for — hangs on `text()` forever, and a wrapper that awaits a
  check-in then never runs the job at all. Here one budget covers every attempt,
  every delay between them, and the read.
- **Refuse a redirect.** The specification turns a redirected `POST` into a
  `GET` with no body, so a canonical-host redirect quietly drops whatever the
  job had to say.
- **Tell a silent monitor from a network blip.** `!response.ok` is true for a
  paused monitor (`410`) and for an id that no longer resolves (`404`). Both of
  those mean *nobody will be alerted about this job again*, and both print the
  line above. Here each is its own outcome, with a sentence of its own.
- **Say it once.** A per-minute job that logs a warning per tick is how a
  monitoring library gets uninstalled. The built-in warner speaks once per
  process, per cause, per monitor.
- **Not throw.** The validator throws — inside the job it is monitoring, on a
  configuration mistake, at whatever hour that job runs. Nothing on this
  package's check-in path throws, ever; see [Never breaks the job](#never-breaks-the-job).

And the `start` check-in it never sends is the one that makes *the job began and
never finished* distinguishable from *the job never began*.
`withMonitor('nightly-backup', runBackup)` sends both ends and the run's
duration.

Replacing a `curl` line in a crontab rather than a module in a codebase? That is
[`cronheart run`](#not-a-node-project), and it needs no Node project around it.

## Never breaks the job

A check-in never throws and never rejects, whatever the network does. Every
path returns a `PingResult` instead:

```ts
const result = await checkIn('nightly-backup')

result.outcome  // 'accepted' | 'duplicate' | 'paused' | 'not-found' | …
result.ok       // the server recorded the check-in
result.sent     // a request actually left the process
result.answered // the server replied to one — a refused connection is sent, never answered
```

`sent` and `answered` are not the same question, and the difference is the one you want at
3am: a refused connection is `sent: true`, `answered: false`, `status: undefined`. `status`
is set exactly when `answered` is true.

`describePingResult(result)` turns any of the twelve outcomes into the sentence this package
would have written for it, so replacing the built-in warner with your own logger is two
lines rather than a switch over the vocabulary:

```ts
import { describePingResult } from 'cronheart'

createPingClient({ onResult: (result) => log.info(describePingResult(result)) })
```

A cancellation you asked for is reported as its own outcome: aborting a `signal`
you passed in gives `aborted`, never `timeout`, so a shutdown does not read as a
deadline nobody set. It is not reported as an answer either — one that lands
while the reply is being read discards what had arrived, because a half-read
body classifies as an accepted check-in and a duplicate would come back as one.

When the budget runs out after the server has already answered with a 5xx, that
answer is what comes back — `server-error` with its status — rather than a
timeout that hides which of the two happened. The two rules point opposite ways
on purpose: a deadline is something that happened to the check-in, and a
cancellation is something you asked for.

A check-in that did not happen is loud rather than silent, whichever way it failed to
happen. A monitor id that resolves to nothing, the `CRONHEART_DISABLED` kill switch, a
refusal from the server and a connection that was never answered each produce their own
outcome plus one `console.warn` — **once per process per cause per monitor**, because a
per-minute crontab that logs a line per tick is how a monitoring library gets removed. A
cancellation you asked for through your own `signal` is the one failure that says nothing:
you already know. Pass `onResult` to replace the warner with your own logger — it replaces
the once-per-cause ledger along with it, so a sink that wants to speak once has to say so.

Names, however, are validated at wiring time: `createPingClient`, `monitors.define`,
`monitors.resolve` and `checkInWith` throw on an unresolvable name, so a typo fails the
deploy rather than going quiet at 3am. A value that is shaped like an id the whole way
through is diagnosed as a **broken id** rather than as a name whose variable nobody set —
and no variable is looked up for one, because screaming a mistyped identifier into a
variable name turns a typo into a search of the environment. `isMonitorId(value)` is
exported so a configuration loader can make the same check at boot without keeping a copy
of the pattern.

The guarantee is mechanical, not aspirational. One `safely()` chokepoint covers
name resolution, URL construction, option reading and body encoding as well as
the request; a source guard fails the build on a network call, a `throw` or a
rejected promise outside the layer that owns them; and a fault matrix runs every
entry point against every way a transport can misbehave, every way a deployment
can be misconfigured, and every way the calling program can hand in something
hostile — an options object whose getter throws, an error whose `stack` accessor
throws, a result sink that rejects, a response whose body never arrives, a
response whose body never stops arriving. Each case asserts that the job's
return value comes back by identity, that its exception propagates unchanged,
that overhead stays bounded, that no promise is left unhandled and that no
identifier reaches a log line. A deliberately unsafe control proves the matrix
can go red.

The reply is read under a cap of its own. A monitor's answer only has to
distinguish an accepted check-in from a duplicate one, and the runtime
decompresses whatever the far side sends before this package sees it — so at
most `PING_RESPONSE_BODY_CAP_BYTES` is retained and the rest of the body is
cancelled rather than buffered. A `fetch` you supply yourself that answers
only through a whole-body `text()` is read the way it answers. The constant is
exported, because a bound a consumer cannot read is a bound they have to take on
trust. The management client reads under `API_RESPONSE_BODY_CAP_BYTES`, exported
from `cronheart/api` and far larger, because a listing is a page rather than a
two-word answer.

Which of the two a response gets is decided by what it hands back. A body that
exposes a reader is read under the cap; one that offers only `text()` is read
whole, the way it answers. Both shapes are typed, so a transport of your own can
say which it is handing over:

```ts
import type { PingHttpResponse, PingResponseBody, PingResponseBodyReader } from 'cronheart'

export function bodyOf(response: PingHttpResponse): PingResponseBody | null | undefined {
  return response.body
}

export function readerOf(body: PingResponseBody): PingResponseBodyReader | undefined {
  return body.getReader?.()
}
```

`getReader` is optional on purpose: a hand-written double that only implements
`text()` still works, and gives up the cap in exchange.

## Configuration

| Variable | Default | Does |
| --- | --- | --- |
| `CRONHEART_<NAME>_UUID` | — | the id for the monitor called `<name>` |
| `CRONHEART_URL` | `https://cronheart.com` | base URL |
| `CRONHEART_TIMEOUT_MS` | `5000` here, `10000` for `cronheart/api` | total budget for one request, across its retries |
| `CRONHEART_RETRIES` | `2` | retries after the first attempt, capped at 5; server errors and network failures |
| `CRONHEART_DISABLED` | unset | `1`, `true`, `yes` or `on` stops every check-in, loudly |
| `CRONHEART_REDACT` | unset | extra redaction patterns for the CLI, one regular expression per line |
| `CRONHEART_API_KEY` | unset | the key `cronheart/api` and `cronheart sync` authenticate with — a check-in never reads it |

`CRON_MONITOR_*` is accepted for all of these, permanently and without a
deprecation warning.

`CRONHEART_URL`, `CRONHEART_TIMEOUT_MS` and `CRONHEART_RETRIES` are read by the
[management client](#management-api) as well. It keeps its own 10 s default,
because an API call made by a person at a terminal is not a heartbeat sent from
inside a job.

A check-in retries a failed connection and a 5xx, never a 4xx — `404`, `410`
and `429` are answers rather than failures. **The default is two retries, so one logical
check-in is up to three requests**, all of them inside one `CRONHEART_TIMEOUT_MS` budget;
set `CRONHEART_RETRIES=0` if your service-side rate limit counts requests rather than
check-ins. The count is capped at 5 however it
is configured, attempts are spaced by 50 ms — less only when less than that is
left of the budget — and the whole sequence, delays included, is spent inside
`CRONHEART_TIMEOUT_MS`. The base URL is
validated when the client is built: a query string, a fragment or a scheme that
is not http(s) is refused there, because the ping path is appended to it and a
check-in would otherwise land on the site root and be recorded as accepted. A
credential in the URL is refused too, and so is plain `http:` to anywhere but
loopback — a check-in body carries a job's own output. A
redirect is never followed either: the specification turns a redirected POST
into a GET without a body, which would drop the job's output on the way.

**Every check-in is a `POST`**, with or without a body. The route also accepts `GET` and
`HEAD`, and a hand-rolled `curl` in a crontab will keep using `GET` — but `GET` is the one
verb a cache or a scanning intermediary may answer on the server's behalf, and a check-in
answered by an intermediary is reported as accepted while the service never saw it. That is
the single failure a monitoring client cannot detect from its own result, so the verb does
not depend on whether you passed a body.

## Schedulers

Adapters instrument the scheduler rather than each job's call site, so jobs added
later are covered without another edit. Six ship today —
[`croner`](https://www.npmjs.com/package/croner),
[`cron`](https://www.npmjs.com/package/cron) (the `kelektiv/node-cron`
repository, whose package is named `cron`),
[`node-cron`](https://www.npmjs.com/package/node-cron) v4,
[`node-schedule`](https://www.npmjs.com/package/node-schedule),
[`bullmq`](https://www.npmjs.com/package/bullmq) and
[`@nestjs/schedule`](https://www.npmjs.com/package/@nestjs/schedule). Each is a
subpath export with its peer declared optional and imported for its types only:
nothing is required at runtime, and an adapter never constructs the scheduler's
objects.

Four of the six hand the scheduler back what it was given — three as its own
argument list, cron as its own parameters object with only the tick replaced —
so the schedule the monitor is checked against is by construction the schedule
the scheduler runs. The
node-cron adapter attaches to that scheduler's events, because a callback wrapper
cannot see a file-path or background task at all, and the NestJS one is a module
that walks the framework's own registry once the application has booted.

```ts
import { Cron } from 'croner'
import { monitored } from 'cronheart/croner'

const job = new Cron(
  ...monitored('nightly-backup', '0 3 * * *', { timezone: 'Europe/Berlin', protect: true }, runBackup),
)
```

```ts
import { CronJob } from 'cron'
import { monitored } from 'cronheart/cron'

const job = CronJob.from(
  monitored('nightly-backup', {
    cronTime: '0 3 * * *',
    timeZone: 'Europe/Berlin',
    waitForCompletion: true,
    onTick: runBackup,
  }),
)
```

```ts
import { scheduleJob } from 'node-schedule'
import { monitored } from 'cronheart/node-schedule'

const job = scheduleJob(
  ...monitored('nightly-backup', { rule: '0 3 * * *', tz: 'Europe/Berlin' }, runBackup),
)
```

```ts
import cron from 'node-cron'
import { monitor } from 'cronheart/node-cron'

const task = cron.schedule('0 3 * * *', runBackup, { timezone: 'Europe/Berlin', noOverlap: true })
const monitored = monitor(task, 'nightly-backup', { timezone: 'Europe/Berlin' })
```

```ts
import { Worker } from 'bullmq'
import { monitored } from 'cronheart/bullmq'

const worker = new Worker(
  ...monitored('digests', { connection, concurrency: 1 }, sendDigest, {
    jobs: { 'nightly-digest': 'nightly-backup', 'warm-cache': false },
  }),
)
```

```ts
import { Module } from '@nestjs/common'
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule'
import { CronheartModule } from 'cronheart/nestjs'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    CronheartModule.forRoot({
      registry: SchedulerRegistry,
      jobs: { nightlyDigest: 'nightly-backup', cleanupTmp: false },
    }),
  ],
  providers: [Digests],
})
export class AppModule {}
```

A monitored run sends a `start` check-in when it begins and a `success` or `fail`
one when it ends, reporting the run's duration and, on a failure, the error's
description in the body. The job's own value comes back by identity and its error
is rethrown as the same object, so the scheduler sees the run it would have seen.
An unresolvable monitor, a schedule the service would refuse and a time zone this
runtime does not know are all refused where the job is wired, never at three in
the morning.

**Overlap.** A schedule shorter than the job interleaves start and terminal
check-ins, and the service reads the span between them as the job's runtime — so
interleaved ones describe a run that never happened. Each scheduler adapter reports
overlapping runs as one, failed if any of them failed, and says once which of the
scheduler's own guards would have prevented it: croner's `protect: true`, cron 4's
and NestJS's `waitForCompletion: true`, node-cron's `noOverlap: true`. node-schedule
has none, and the warning says so. The collapse never skips the job. A queue is the
one case where parallel runs are the point rather than an accident, and the BullMQ
adapter answers it differently — see **Queues** below.

**Cron dialect.** Every one of these schedulers accepts a six-field expression whose
first field is seconds; a cronheart schedule has five fields plus seven `@` aliases
and no seconds field. An expression only the scheduler would take is refused at
wiring time with a message naming the dialect, because sending it would leave the
monitor's schedule and the job's schedule disagreeing with nobody told. A one-off
`Date` for cron's `cronTime`, a `RecurrenceRule` and node-schedule's object spec
carry no cron dialect and are passed through untouched; the croner adapter takes
a string pattern and nothing else. A BullMQ schedule is the exception: it lives on
the queue rather than on the worker, so the pattern is only visible when a job
arrives, and a dialect the service would refuse is a warning there rather than a
refusal.

**Time zone.** The zone the scheduler fires in has to be the monitor's, or the
alert lands at the wrong hour and reads as a service fault. Where the scheduler
takes the zone in the same object the adapter does — croner, cron and
node-schedule — an unknown zone is refused at wiring time, and a schedule pinned
to an hour of the day with no zone named warns once, saying which zone it will
actually fire in. node-cron keeps the zone in the options the task was created
with and exposes none of them, so there you repeat it to the adapter —
`monitor(task, name, { timezone: 'Europe/Berlin' })` — and a zone this runtime
does not know is refused exactly as it is elsewhere. Say nothing and the adapter
says nothing: it cannot see whether you named one, and a warning it has no
evidence for is a warning you would learn to ignore.

**Flushing.** Every adapter but node-cron's awaits the terminal check-in before the
tick resolves, so a process that exits at the end of its run cannot outrun it.
node-cron emits on an event emitter that neither awaits a listener nor reads what
it returns, so its adapter holds the work itself: `await monitored.flush()` before
the process exits, or `flush()` from `cronheart` for the shared client. The NestJS
module flushes what it started when the application shuts down.

**Queues.** A monitor stands for a schedule, and a queue is not one. The BullMQ
adapter wraps the processor rather than the worker's events, so a check-in is tied
to the job name that asked for one and nothing is sent for the rest of the queue,
and it answers three things a queue does that a scheduler does not:

- **Retries.** A queue that retries a failed job would drive the monitor down on
  the first attempt of a job that succeeds on its third. The failure is reported
  once the job has exhausted the attempts it was given, and not before.
- **One-off jobs.** A job added by hand is not on a schedule, so it arriving late
  or not at all says nothing about a monitor. Those are left alone, with one
  warning naming the monitor the job was mapped to; `allowOneOff: true` checks
  in for them anyway.
- **Concurrency.** A worker running jobs in parallel would interleave the start
  check-ins of runs that are genuinely separate. Above a concurrency of 1 the
  start check-in is off by default and the adapter says so once, each run still
  reporting how long it took; `pingStart: true` sends them anyway.

**NestJS.** `CronheartModule.forRoot()` walks the scheduler's registry once the
application has booted and wraps the registered jobs the mapping names, so no
call site changes and no decorator has to sit in the right place. It takes the
framework's own `SchedulerRegistry` class as the injection token, because the
module imports nothing of the framework at runtime. At startup it writes one line
saying what it covers — `cronheart: monitoring 3 of 5 cron jobs; unmapped:
warmCache, sweepSessions.` — so a job nobody monitors is visible rather than
silent; map a job to `false` to leave it out on purpose, and out of that line.
A job whose callback the scheduler keeps somewhere the adapter cannot reach gets
a clause of its own on that line rather than being passed off as monitored. Pass
`report` to send the line somewhere other than the console.

A `@Cron` method that throws is caught and logged by the scheduler itself before
anything outside it can see the failure, so a run that failed inside the method
checks in as a completed one. Where a job's own failures have to reach the monitor,
bracket the work inside the method with `withMonitor` from `cronheart` and leave
that job out of the mapping.

**Not covered.** cron also accepts a shell command string as its tick; nothing in
this process can bracket one, and `cronheart run` is the wrapper for that.

## CLI

```bash
cronheart init                                    # create or paste a monitor, write the env var, verify it
cronheart run --name=nightly-backup -- ./backup.sh
cronheart ping nightly-backup --action=fail --body=-
cronheart sync --check                            # does the account match the configuration file?
cronheart doctor
cronheart run --help                              # options and examples for one command
cronheart --version                               # the version, and the wire contract it was built against
```

`sync` reconciles a whole project's monitors against a file it never writes to;
it needs an API key on a paid plan, and it has a section of its own —
[Declarative sync](#declarative-sync).

`run` wraps a command. It opens with a `start` check-in, then reports success —
or failure, carrying the exit status and the tail of the command's output as the
body — and **exits with the command's own exit status**. A run that succeeded
sends no excerpt, having nothing to diagnose. A check-in that fails
writes one line to stderr and changes nothing else: a monitoring outage must
never turn a working job into a failing one.

**Nor may a monitor it cannot use.** `--uuid=$BACKUP_ID` in a crontab whose variable went
missing expands to an empty flag value; so does a value behind `--uuid` that is not an id
at all, a name behind `--uuid`, or both flags at once. Each of those writes a line to stderr
saying the command ran **unmonitored**, and then runs it. An id that is well-formed but no
longer exists is *not* one of these — that run is monitored, and the check-in comes back
`404` with a sentence saying so. Refusing to spawn would trade a working nightly
backup for a diagnosis, which is a worse outcome than an unmonitored one.

A run that ends in anything but `0` also writes its summary to **stderr**, so
cron mails it the way it would have mailed the unwrapped command's own error; a
run that succeeds writes no summary. It still writes a line for a check-in that
failed or a configuration it refused, because those are about the monitoring
rather than about the job. A wrapper may be silent on success. It
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
recognised out of the box, and redaction reaches back 2 KiB of the stream at
each of those boundaries — a single secret longer than that is not covered at
any of them. `--redact=<pattern>` (repeatable) and `CRONHEART_REDACT` add more, and `--output-bytes=0` sends no excerpt at all —
and inserts no pipe on either stream, so anything the command leaves running
keeps the caller's own stdout and stderr. A pattern that does not compile is
never a control that quietly protects nothing: on the command line it is a
usage error, while in
`CRONHEART_REDACT` — one typo in which would otherwise stop every wrapped job
on the machine — the command runs and the excerpt is withheld entirely, said
so on stderr. The command being wrapped is not given `CRONHEART_API_KEY`:
check-ins need no key, so there is nothing to trade away.

Four exit statuses are the wrapper's own rather than the command's, and each
covers a case where there is no command status to report: `64` when the
invocation could not be read at all — an unknown flag, a flag given no value, no
monitor flag, nothing after the `--` — which happens before anything is spawned;
`124` when `--timeout` expires, matching `timeout(1)`; and `127` when nothing of
that name is on `PATH`, `126` for every other reason a spawn failed. A fifth,
`70`, is the wrapper failing in a way it did not anticipate; seeing one is worth
a bug report. A command a signal ended returned no status either, and is
reported as `128` plus the signal number, the way a shell reports one. A command
that has already exited can no longer time out, whatever is still holding its
output streams open.

The line between `64` and an unmonitored run is worth stating, because it is the line a
crontab crosses at 3am: **`64` means the wrapper could not read what you asked it to do;
a monitor it read and cannot use is not that.**

Run with no terminal — from cron, a systemd timer, a supervisor — the command
leads its own process group, so `SIGINT`, `SIGTERM` and the `--timeout`
deadline are delivered to that whole group and a shell script's children go
with it. Run **from a terminal** it does not: a process group of its own means
`setsid`, which costs the command the controlling terminal that a `sudo` or
`ssh` password prompt needs, and the terminal has already delivered the
interrupt to the whole foreground group anyway — so the wrapper does not relay
it a second time, which many tools read as *abort now*. Escalation to `SIGKILL`
follows after `--kill-after` (5s by default, and never when it is longer than a
timer can hold). The check-in body says the run was signalled, and says so when
the wrapper was the one that escalated — otherwise an alert cannot tell a job
something else killed from one this wrapper killed.

A server that never answers cannot hold the command up: the terminal check-in
and its flush share one 2 s budget, after which the status already in hand is
returned and whatever is in flight is abandoned. An interrupt arriving during
that budget does the same rather than replacing the status with `130`.

`ping` sends one check-in and exits `0` even when the check-in fails — including when the
monitor resolves to nothing — for the same reason `run` does; `--strict` turns a failed
check-in into exit `1`. It is
**silent on a check-in that worked** and writes to stderr on one that did not,
the way `curl -fsS` behaves — one mail per run from a per-minute crontab is how
a monitoring tool gets uninstalled. At a terminal, or under `--verbose`, the
confirmation is printed. `--action` is validated against a closed set of
literals before a URL exists, because the server maps an action it does not
recognise to a plain heartbeat — which marks the monitor *up*. That set is
`PING_ACTIONS`, exported from the package, so a caller generating the flag can check the
value before passing it; `heartbeat` is in it and means the same as leaving `--action` off.
`PING_EMITTABLE_ACTIONS` is the subset that becomes a path segment.

Whatever went wrong, what gets printed is the sentence the client wrote for
it — *no monitor id for "cleanup", so nothing was sent. Set
CRONHEART_CLEANUP_UUID…* — rather than the outcome token behind it. A check-in
that worked has no such sentence, so the confirmation a terminal or `--verbose`
prints is the outcome line itself.

`doctor` reports the configuration it resolved, which environment variable
answered for each monitor, the result of a real check-in and the clock skew
against the server. It never prints a monitor id: that id is the whole
credential for the check-in route, and an id passed where a name belongs is
shown as its last four characters. It also names what it did **not** check —
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

A global install is not the only route onto a machine. The built wrapper is published under
the `cronheart/cli` specifier as well as under `bin`, so a container build or a deploy
script that already depends on the package can resolve it and copy it where cron will find
it:

```js
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

copyFileSync(fileURLToPath(import.meta.resolve('cronheart/cli')), '/usr/local/bin/cronheart')
```

`require.resolve('cronheart/cli')` does the same from CommonJS. **Resolve it and run it; do
not import it** — it is a program rather than an API, and importing it deliberately does
nothing at all rather than reading your process's arguments and exiting it. There is no
programmatic entry point on purpose: the wrapper's contract is its exit statuses and its
streams, and everything it does with the service is already reachable through `cronheart`,
`cronheart/api` and `cronheart/sync`.

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

A request the service is certain to refuse is refused here instead, with a
message that names the field the value came from: a channel missing the key its
kind needs, a time zone the runtime cannot name — the service reports that one
against the schedule expression — and a name or label outside its bounds,
counted in characters as the service counts them rather than in UTF-16 code
units, so one emoji is one. Every one of those bounds is exported from
`cronheart/api`, so a form you validate yourself can read the same numbers.

`api.rateLimit()` is what the last answered request reported, and it is a
function so that it keeps working when it is destructured off the client the way
every other member does.

### Paging has three shapes and they are not interchangeable

| Listing | Shape | This package |
| --- | --- | --- |
| monitors | offset | `monitors.list()` for one page, `monitors.iterate()` for an async iterator |
| a monitor's alerts | offset | `monitors.alerts(uuid)` for one page, `monitors.iterateAlerts(uuid)` for an async iterator |
| a monitor's pings | opaque cursor | `monitors.pings(uuid)` for one page, `monitors.iteratePings(uuid)` for an async iterator |
| channels | **none at all** | `channels.list()` returns the whole set — and is deliberately not an iterator |

The channels listing reads no pagination parameters and echoes none back, so a
generic offset walk pointed at it cannot even tell one request's worth from the
whole set, and never terminates.

The monitor listing orders by creation time **with no tiebreaker**, and
creation time is stored to the whole second. Rows created in the same second
have no defined relative order, so a deep walk can repeat a row or skip one.
`iterate()` drops repeats by identifier; it cannot recover a skip. Do not build
anything that depends on two walks of an unchanged account agreeing. The alert
listing breaks the tie on the identifier and is a total order, so `iterateAlerts()`
needs none of that — the channels listing, which has no paging at all, is the
other one with no tiebreaker.

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
pass an `idempotencyKey`**, and it is the one request whose wait grows with the
attempt — 250 ms per attempt, against the flat 50 ms every other retry spends.
The key reserves a row for 60 seconds, so a retry sent immediately is
refused as a conflict while the resource was in fact created. A `409` on a
create says so — read the resource back before deciding it was not created.
Rotations and channel tests are never retried at all. `CRONHEART_RETRIES` is
read here too, and capped at 5 the same way — one bound, shared with the
check-in transport, which neither client can raise. An idempotency key that is
blank counts as no key at all, because that is what the service does with one:
a blank key would otherwise turn retries on and create a second monitor.

`cronheart/sync` reconciles a declared set of monitors against the service —
see below. Each is a separate entry point so the ping path stays small in
production bundles.

## Declarative sync

`cronheart/sync` and `cronheart sync` reconcile the monitors of one project
against a file. `defineMonitors` is where the wire's sharp edges get absorbed:
a five-field string is a cron expression, one of the twelve fixed tokens is a
preset, and `{ every: '5m' }` becomes the whole number of seconds *written as a
string* that the service actually wants — a detail nobody should have to find
out from a 422.

Like the rest of the [Management API](#management-api), this needs
`CRONHEART_API_KEY` and a key needs the **Starter plan or above**. Check-ins
work on every plan, Free included, and nothing here is required to be
monitored — a Free account writes its monitors in the dashboard and skips this
section entirely.

```ts
// cronheart.config.ts
import { defineMonitors } from 'cronheart/sync'

export default defineMonitors([
  { name: 'nightly-backup', schedule: '0 3 * * *', channels: ['ops inbox'] },
  { name: 'sweep',          schedule: { every: '5m' }, channels: 'none' },
  { name: 'legacy-import',  schedule: '@daily', channels: ['ops inbox'] },
])
```

Every row names its routing on purpose. Leaving `channels` off entirely is a
third state — *sync does not manage this monitor's routing* — and it is only
meaningful for a monitor that already exists: a **create** that would attach
nothing verified is refused rather than made silent. See
[Three ways a reconciler can silently switch off your alerting](#three-ways-a-reconciler-can-silently-switch-off-your-alerting).

```bash
cronheart sync            # print the plan; change nothing
cronheart sync --check    # the CI gate — see the statuses below
cronheart sync --apply    # make the changes
cronheart sync --apply --print-env >> .env
```

`--check` answers with the exit status, and there are three answers, not two:
**exit 0** once the account matches the file, **exit 2** while anything
differs, and **exit 1** when the run could not answer the question at all — a
refused key, an account the API is not entitled to, a server that never
replied, a configuration this command would not read, a row the plan refused, a
name two monitors on the service both carry. A build step that treats anything
non-zero as drift reads "the key expired" as "there are changes to
make", which is why the two answers and the failure are three statuses rather
than two. An invocation the command could not read at all — an unknown flag,
`--apply` and `--check` together — still exits `64`, before it gets as far as
asking.

Under `--print-env`, stdout carries the `CRONHEART_<NAME>_UUID` assignments and
nothing else: the plan, the tally and every notice go to stderr, so appending
the run to a `.env` leaves a file `docker compose --env-file` and `set -a; . ./.env`
can still read.

A `.json` file carrying the same monitors under a `monitors` key works too,
for a project that is not TypeScript. There is no YAML, and there will not be:
it costs a runtime dependency, and the zero-dependency promise is worth more.

**How a `.ts` config is loaded, plainly:** it is `import()`ed, and *the runtime*
strips the types. Node does that by itself from 22.18 onward and behind
`--experimental-strip-types` from 22.6; below 22.6 there is no flag and a `.ts`
config does not load at all, so use `.mjs` or `.json` there. Nothing here compiles anything, and
no compiler is bundled to close the gap — a `.mjs` or `.json` file needs
neither. The file is only ever read; sync never writes to it.

Stripping is not checking. The runtime erases the annotations and runs what is
left, so a misspelled key in that file is a property nothing reads rather than
an error anyone sees — `defineMonitors` refuses what it can decide at run time,
and a typo in an optional field is not one of those. The types are there to be
checked by a compiler, so run one beside the gate:

```bash
tsc --noEmit cronheart.config.ts && cronheart sync --check
```

### Identity is the whole problem, and it is fragile

There is no server-side upsert, no exact-name filter and **no uniqueness
constraint on monitor names**. So a monitor is identified by its name,
client-side, and every consequence of that is deliberate:

- Two monitors of one name **in the file** is an error at parse time, before a
  credential is read or a request exists.
- Two monitors of one name **on the service** is a conflict: reported and
  skipped. There is no way to know which one was meant.
- The listing is offset-paged, ordered by creation time with **no tiebreaker**,
  so a deep walk can repeat a row or skip one. Repeats are dropped by
  identifier; the listing is treated as advisory, not as truth.
- Every create carries a deterministic `sync-<sha256>` idempotency key derived
  from the request, so a repeated run **inside the service's replay window**
  cannot mint a duplicate even when the listing failed to report the monitor.
  That window is what the service underwrites and no more: the reservation a
  finished create leaves behind is swept on a 24-hour cutoff, so a re-run a day
  or two later executes for real and the listing — the thing that can skip a
  row — is the only defence left. Web Crypto derives the key; this entry
  imports nothing from `node:`, and no Web Crypto means the create is refused
  rather than sent unguarded.

The monitor payload carries **no project identity**, and reads and creates are
confined to whichever project the API token is scoped to. Sync says so in its
output rather than implying it considered the whole account.

### Three ways a reconciler can silently switch off your alerting

All three are made structurally impossible rather than documented:

**The routing field replaces wholesale when present — even when empty — and is
left alone when absent.** So `channels` has three states, written down rather
than inferred: a list, the word `'none'`, or *absent* — which means sync does
not manage the routing at all and sends no such field, and which the literal
`'unmanaged'` says out loud for a file that would rather not lean on omission.
Emptying a monitor's routing takes the literal `'none'`; an empty list is
refused, because that is what a defaulted value (`channels: ids ?? []`) looks
like and it would silence the monitor. One function decides that field, and a test enumerates every mode
of the union against it.

**A monitor with no attached, verified channel alerts nobody.** The dashboard's
form pre-selects the account's verified channels; the REST surface attaches
none. So a create whose channels are empty — or all unverified — is **refused**
unless the file wrote `'none'`. The same refusal covers an *update*: a file
that names channels and resolves to nothing verified is this run silencing the
monitor, whether it existed beforehand or not. Silence that was already there
when the run started is reported instead, because closing it would move a field
nobody wrote down. Rows that alert nobody are marked `!` and counted in the
tally, so the fact is read at a glance rather than at the end of the longest
line — and a monitor that is paused or snoozed says so in place of a channel
list, since the service scans neither for lateness. The table carries the rows
that differ; unchanged ones are counted in the tally and left out, and `--all`
puts them back — except a row that alerts nobody, which is shown either way,
because it is unchanged precisely when nothing in the file is fixing it. Sync cannot diff a
channel's destination — the service redacts `webhook_url`, `url` and `secret` —
only its ownership and label, and it does not pretend otherwise.

**A channel named by digits is not assumed to be an identifier.** The service's
rule for a label is a length and nothing else, so `"911"` and `"2026"` are
legal labels. A reference is matched against both labels and identifiers; one
that answers to two different channels is refused for the same reason a
repeated label is, rather than quietly paging whichever the shape happened to
select.

### Pruning

`--prune` covers monitors on the service that the file does not describe.
Deleting a monitor destroys its check-in history irreversibly, so an orphan is
**reported by default and never deleted**; deleting takes `--apply --prune`
*and* a confirmation (`--yes`, or typing `delete` at a terminal). Under
`--check`, orphans only count as a difference when `--prune` says the file is
meant to be the whole of the account.

Answering the confirmation with anything but the word deletes nothing and exits
**0**: declining a destructive prompt is the prompt doing its job, not the run
failing. A run with no terminal to ask at and no `--yes` is that same answer,
reached without anybody there to give it. The run says so in as many words, so
that `0` is never read as "there was nothing to delete".

Deleting is conditional on the half of the run that would replace what it
deletes. Two rules, both refusals rather than warnings:

- **Nothing is deleted while anything else in the run failed** — a refusal the
  plan raised, a create the service rejected, a request that never landed. The
  irreversible half does not proceed on the strength of a half that did not.
  The confirmation is not even offered, and the run says why.
- **Nothing is deleted for a file that describes no monitors at all.** A glob
  that matched nothing, a truncated write and a list built from an unset
  variable all arrive looking exactly like an instruction to empty the project,
  and an empty file is far more often the first three. There is no proportion
  threshold for the same reason a threshold would be guesswork: instead the
  confirmation states how many of how many would go, and it is printed before
  any delete whether or not anybody is there to answer it — under `--yes` that
  line is the only record the run leaves.

`--print-env` emits the `CRONHEART_<NAME>_UUID` lines — the thing that closes
the gap between "sync created these" and "my jobs can address them". It is the
only output that carries a monitor's identifier; the plan table never prints
one, because that identifier is the entire credential on its check-in route.

## Runtime support

Node 22 or newer, zero runtime dependencies. The root entry imports nothing
from `node:`, which is what keeps non-Node runtimes on the table; the CLI is
the only entry point that reaches for Node built-ins, and a test enforces the
split. What your users download is the ping entry gzipped once their bundler has
minified it, and that is what the budget is measured on:
CI fails on a regression past 7,168 bytes, which is 7 KiB. That ceiling is what
this package promises; what a given build measures is printed by the size check
on every run, minified and unminified both, so a regression in either is visible
without a figure quoted here going quietly stale. The CLI is bundled
apart from the library entries so that it cannot pull the ping path into a
shared chunk and charge every consumer for import glue it has no use for. The
management client is bundled apart for the same reason: a chunk shared with the
root puts part of the ping path behind import glue that every consumer of the
check-in client then pays for.

## Versioning, public API and Node support

**What is public.** The surface this package versions is what the export map
resolves, and nothing else.

| Specifier | What it is |
| --- | --- |
| `cronheart` | the check-in client — the entry that ships into a production bundle |
| `cronheart/api` | the management client for the REST API |
| `cronheart/sync` | the reconciler behind `cronheart sync` |
| `cronheart/testing` | a ping recorder and the warning-ledger reset, for your own tests |
| `cronheart/croner`, `/cron`, `/node-cron`, `/node-schedule`, `/bullmq`, `/nestjs` | the six scheduler adapters |
| `cronheart/cli` | the built command-line program — resolve it and run it, never import it |
| `cronheart/package.json` | the manifest, for a tool that wants to read the version |
| the `cronheart` binary | its contract is its exit statuses and its streams |

Everything else is internal and may change in any release, a patch included:

- **Any path into `dist/`.** The chunk filenames carry a content hash and are
  regenerated on every build. `cronheart/dist/index.mjs` is not a specifier.
- **The stub directories** — `api/package.json` and its eight siblings — exist
  so that TypeScript's legacy `moduleResolution: node`, which reads no export
  map, still resolves the subpaths. They are packaging, not an entry point.
- **The command-line tool has no programmatic surface**, deliberately;
  importing it does nothing at all.
- **`build/` is not published.** It holds the build-time module the wire
  contract's constants are read from. Neither it, nor the tests, nor the
  fixtures, nor the conformance vectors are in the tarball — and that is
  asserted against the packed artifact on every run of the gate rather than
  left to the `files` list to be right about.

**What a version number means.** Semantic versioning, with the `0.x` caveat
stated rather than assumed: until `1.0.0`, a **minor** may break the public
surface and a patch never will. That is what the `0.x` line is for — it lets
real use correct API mistakes before anyone is owed a stability guarantee.
`0.1.0` shipped eleven such corrections, every one found by migrating a working
consumer onto the package rather than by reading the code; `0.1.1` added four
more, each of them something the package reported wrongly rather than something
it could not do. [CHANGELOG.md](CHANGELOG.md) names all fifteen.

**Node.** The floor is Node 22, and the policy is the oldest Node LTS still in
maintenance: when a release reaches end of life it is dropped, which is a minor
bump while this package is on `0.x` and a major after `1.0.0`. CI runs the
suite on the floor, on the current LTS and on `latest`, in both module systems;
a Node version outside that matrix is not supported however well it happens to
work. The check-in entry imports nothing from `node:`, which keeps a runtime
that only provides `fetch` on the table — that is a property the tests pin, not
a support promise.

Reporting a vulnerability, and the properties worth reporting against:
[SECURITY.md](SECURITY.md). How a release is cut: [RELEASING.md](RELEASING.md).

## Development

Everything runs inside Docker — no Node or pnpm on the host:

```bash
make install      # pnpm install
make build        # bundle dist/ (ESM + CJS + .d.ts)
make test         # Vitest
make lint         # tsc, fixture consumer tsc, source guard, publint, attw, size
make vectors      # the language-neutral conformance vectors
make matrix       # the fault matrix and its negative control
make drift        # the wire contract against the snapshot of the published API
make docs         # compile every documented sample, probe every documented flag
make check        # the full gate, including the ESM/CJS consumption smoke
make release-gate # what only a tag has to satisfy — run it before tagging
make shell        # interactive shell in the container
```

`make help` lists every target. CI runs the same checks natively across a Node
version matrix, and the release workflow runs that CI workflow as its gate
rather than a copy of its steps. One check is deliberately not in it: the drift
watch's live half fetches the published API specification, so it runs on a
schedule and opens a pull request when the service moves, rather than letting an
unreachable host fail somebody's review. Cutting a release —
`make changeset`, `make version`, and the tag that publishes it — is
[RELEASING.md](RELEASING.md).

## License

MIT — see [LICENSE](LICENSE).
