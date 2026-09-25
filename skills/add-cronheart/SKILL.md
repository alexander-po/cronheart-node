---
name: add-cronheart
description: Add cronheart.com check-in monitoring to the scheduled jobs of a Node.js project. Use when asked to monitor cron jobs, add a heartbeat or dead man's switch to scheduled tasks, or wire croner, cron, node-cron, node-schedule, BullMQ, NestJS schedule or a crontab script to cronheart. Detects the scheduler, installs the cronheart package, wraps each job with its adapter, creates the monitors, puts each id in the environment and verifies the first check-in.
---

# Add cronheart to a Node project

Work through steps 1-7 in order; each says what to run and what done looks
like. Steps 8 and 9 are reference: what an error means, and what not to do.
Every monitor id and API key in this file is a placeholder:
`00000000-0000-4000-8000-000000000000` is never a real monitor and
`cmk_replace-me` is never a real key. Nothing here needs to be typed from
memory — the README of the package states the same facts at more length, and
this recipe is held to the built package by the same gate.

## 1. Check the floor

Run `node --version`. The package needs Node 22 or newer, has zero runtime
dependencies and runs nothing at install time. A lower Node is the one thing
this recipe cannot work around.

Done when the version printed is 22 or above.

## 2. Detect the scheduler

Read the project's `package.json` dependencies, then find where jobs are wired:

```bash
git grep -lE "from ['\"](croner|cron|node-cron|node-schedule|bullmq|@nestjs/schedule)['\"]"
```

Jobs with no Node scheduler are started by a crontab, a systemd timer or a
supervisor; `crontab -l` and the unit files under `/etc/systemd/system` list
them. One row applies per job, and a project may need several rows.

| Found | Wrap with | From |
| --- | --- | --- |
| `croner` | `monitored(name, pattern, options, job)`, spread into `new Cron(...)` | `cronheart/croner` |
| `cron` — the package whose class is `CronJob` | `monitored(name, params)`, handed to `CronJob.from(...)` | `cronheart/cron` |
| `node-cron` | `monitor(task, name, { timezone })` on the task `cron.schedule` returned | `cronheart/node-cron` |
| `node-schedule` | `monitored(name, spec, job)`, spread into `scheduleJob(...)` | `cronheart/node-schedule` |
| `bullmq` | `monitored(queue, workerOptions, processor, { jobs })`, spread into `new Worker(...)` | `cronheart/bullmq` |
| `@nestjs/schedule` | `CronheartModule.forRoot({ registry, jobs })` in the root module | `cronheart/nestjs` |
| a `setInterval`, a hand-rolled loop, a serverless handler | `withMonitor(name, job)` around the work, or `checkIn(name)` once it is done | `cronheart` |
| a script started by crontab, a timer or a supervisor | `cronheart run --name=<name> -- <command>` | the `cronheart` binary |

Done when every scheduled job has a row.

## 3. Install

```bash
npm install cronheart
```

`pnpm add cronheart`, `yarn add cronheart` and `bun add cronheart` do the same.
The scheduler adapters import their scheduler for its types only, so nothing
else is installed. A host that runs jobs from a crontab and has no Node project
gets a global install with the version pinned — `npm install -g cronheart@<version>` —
because `npx` re-resolves the package on every run and needs a warm cache at
cron time.

Done when `npx cronheart --version` prints the version and the wire contract it
was built against.

## 4. Name each job

One monitor stands for one schedule, and its name is the job's stable
identifier: lowercase words joined by hyphens, such as `nightly-backup`. The id
of that monitor is read from `CRONHEART_<NAME>_UUID`, where `<NAME>` is the name
upper-cased with every run of characters outside `A-Z0-9` replaced by one
underscore — `nightly-backup` reads `CRONHEART_NIGHTLY_BACKUP_UUID`.

Use the name in code, never the id, so the id lives in the environment and not
in the source. A name that cannot be resolved fails at wiring time, on purpose:
a typo crashes the deploy instead of going quiet at three in the morning.

Done when every row of step 2 has a name and the variable derived from it.

## 5. Wrap each job

Copy the sample for the adapter the row named. The job's return value comes
back by identity and its error is rethrown as the same object, so the scheduler
sees the run it would have seen; a `start` check-in opens the run and a
`success` or `fail` one closes it, carrying the duration.

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
import cron from 'node-cron'
import { monitor } from 'cronheart/node-cron'

const task = cron.schedule('0 3 * * *', runBackup, { timezone: 'Europe/Berlin', noOverlap: true })
const monitoredTask = monitor(task, 'nightly-backup', { timezone: 'Europe/Berlin' })

process.on('SIGTERM', () => {
  void monitoredTask.flush().then(() => process.exit(0))
})
```

```ts
import { scheduleJob } from 'node-schedule'
import { monitored } from 'cronheart/node-schedule'

const job = scheduleJob(
  ...monitored('nightly-backup', { rule: '0 3 * * *', tz: 'Europe/Berlin' }, runBackup),
)
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

```ts
import { checkIn, withMonitor } from 'cronheart'

await withMonitor('nightly-backup', runBackup)

await checkIn('nightly-backup')
```

Rules that hold for every adapter:

- Give the adapter the time zone the scheduler fires in. Where the scheduler
  takes it in the same object — croner, cron, node-schedule — it is read from
  there; node-cron exposes none of its options, so it is repeated to `monitor`.
- A cronheart schedule has five fields. A six-field expression with a seconds
  field is refused at wiring time; rewrite it before wiring.
- Turn the scheduler's own overlap guard on: croner's `protect: true`, cron's
  and NestJS's `waitForCompletion: true`, node-cron's `noOverlap: true`.
  Overlapping runs are collapsed into one check-in pair and warned about once.
- The node-cron adapter cannot await the terminal check-in, so a process that
  exits at the end of a run flushes it first, as the sample does.
- A BullMQ queue is not a schedule. Map each repeatable job name to a monitor,
  and a name to `false` to leave it out on purpose rather than by omission; a
  job added by hand is left alone.
- A NestJS method that throws is caught by the framework before the adapter
  sees it. Where a failure has to reach the monitor, bracket the work inside
  the method with `withMonitor` and map that job to `false`.
- Do not wrap a check-in in `try`/`catch`. It never throws and never rejects;
  every failure is a `PingResult` and one warning per process per cause.

Done when the project's type check passes and the process boots.

## 6. Create the monitors and put each id in the environment

Two routes, and both end with `CRONHEART_<NAME>_UUID` set where the job runs and a
check-in proving it. Take route B by default: its first step makes the account and
its API key when there is none yet. Route A is the dashboard, for a person who
already has an account there and would rather click.

### Route A — the dashboard

1. Create the monitor at https://cronheart.com/dashboard with the job's schedule
   and time zone. The dashboard form pre-selects the account's verified
   notification channels, which the REST API does not.
2. Record its id and prove it works:

   ```bash
   cronheart init --name=nightly-backup
   ```

   The command asks for the id and reads it without echoing. Run without a
   terminal, it reads the answer from standard input instead, so the id is
   never on a command line. It writes `CRONHEART_NIGHTLY_BACKUP_UUID` to `.env`
   — a new file readable by its owner alone, or the existing line replaced —
   sends one check-in and exits 0 when the server recorded it. `--env-path=<path>`
   writes elsewhere and `--print-env` prints the line instead of writing it.

### Route B — an API key

1. Get the key from the terminal. Ask the person the monitoring is for which
   address to sign up with, and whether they accept the Terms of Service
   (https://cronheart.com/terms) and the Privacy Policy
   (https://cronheart.com/privacy): signing up accepts both, and the acceptance
   the service records is their own click on the mailed page, so never pass the
   flag on their behalf without asking. Then write the key to a file outside the
   repository, where it is never committed and never loaded into the job's
   environment with the project's `.env`:

   ```bash
   mkdir -p ~/.config/cronheart
   cronheart signup you@example.com --accept-terms --env-path=$HOME/.config/cronheart/api-key.env
   ```

   The command prints a code within a second or two, then waits — up to 30
   minutes — while the address gets a mail with one link that the person opens
   to type the code. It only returns once that is done, so run it where a long
   wait survives and its output can be read while it runs: start it as a
   background task and read the code from its output, or ask the person to run
   it in their own terminal. Give the person the code; the mail never carries
   it. The command then writes `CRONHEART_API_KEY` to that file, readable by its
   owner alone, and exits 0. The key is printed on stdout only if that file is
   refused or the write fails after the confirmation, because nothing else holds
   it then: write that line into the file at once, and tell the person that the
   key is now in this session's output, so that they can replace it with a new
   one from the API tokens page. An active account at that
   address is mailed that nothing changed, and the code never confirms: stop
   the command and take a key from Account → API tokens
   (https://cronheart.com/account/api-tokens) instead, where it is shown once,
   when it is created. A key begins with `cmk_`. The new account has no
   password until one is set with Forgot password on the sign-in page, and no
   notification channel: `cronheart init` refuses to create a monitor that
   would alert nobody, so the person adds and verifies one in the dashboard, or
   `--channels=none` says that a monitor alerting nobody is what was meant.
2. Export it in the shell that runs the commands below, never in the job's own
   environment — a check-in does not read it, and `cronheart run` withholds it
   from the command it wraps:

   ```bash
   export CRONHEART_API_KEY="$(sed -n 's/^CRONHEART_API_KEY=//p' ~/.config/cronheart/api-key.env)"
   ```

   A shell that does not keep variables between commands takes the assignment
   in front of each command instead.

The REST API is on every plan, Free included — https://cronheart.com/pricing
states the per-plan rate limit rather than a plan gate, 30 requests per minute
on Free and higher above it. Route A remains the way to create a monitor
without a key, from an account the person can already sign in to.

For one monitor:

```bash
cronheart init --name=nightly-backup --schedule='0 3 * * *'
```

This creates the monitor — a billed resource, counted against the plan's
monitor budget — attaches every verified channel the account has, writes the
variable and verifies it with a check-in. A monitor of that name already on the
account is reused rather than duplicated. An account with no verified channel
is refused with exit 1, because the monitor would alert nobody; `--channels=none`
says that is what was meant.

For a project with several jobs, keep the monitors in a file the repository
owns:

```ts
import { defineMonitors } from 'cronheart/sync'

export default defineMonitors([
  { name: 'nightly-backup', schedule: '0 3 * * *', tz: 'Europe/Berlin', channels: ['ops inbox'] },
  { name: 'sweep', schedule: { every: '5m' }, channels: 'none' },
])
```

Save it as `cronheart.config.ts` (or `.mjs`, or a `.json` with the same rows
under a `monitors` key), then:

```bash
cronheart sync
cronheart sync --apply --print-env >> .env
cronheart sync --check
```

The first prints the plan and changes nothing. The second makes the changes and
appends the variables to `.env`; under `--print-env`, stdout carries the
assignments and nothing else. The third is the CI gate: exit 0 once the account
matches the file, 2 while anything differs, 1 when it could not answer — a
refused key, a server that never replied. Monitors on the service that the
file does not describe are reported and never deleted unless `--apply --prune`
and a confirmation say so.

From code, the management client does the same:

```ts
import { createCronheartApi } from 'cronheart/api'

const api = createCronheartApi({ apiKey: process.env.CRONHEART_API_KEY })

const monitor = await api.monitors.create(
  { name: 'nightly-backup', scheduleKind: 'cron', scheduleExpr: '0 3 * * *', channelIds: ['12'] },
  { idempotencyKey: 'create-nightly-backup-monitor' },
)
```

Channel ids are the strings the listing gave; a create attaches none by itself.

### Where the id lives

- **An application** reads `.env` at startup through whatever loads it —
  `node --env-file=.env`, the container's env file, the platform's secret
  store. Check that `.env` is in `.gitignore` before committing.
- **A crontab** sources no profile, so the variable goes into the crontab
  itself, above the line that uses it, and both paths are absolute:

  ```cron
  CRONHEART_NIGHTLY_BACKUP_UUID=00000000-0000-4000-8000-000000000000
  0 3 * * * /usr/local/bin/cronheart run --name=nightly-backup -- /usr/local/bin/backup.sh
  ```

  `cronheart init --name=nightly-backup --print-env` prints that first line
  with the id filled in. The README also shows the id written inline as
  `--uuid=<id>`; prefer the variable, because arguments are visible to every
  user of the host through `ps` and the id is the whole credential for the
  check-in route.
- **A systemd timer** carries it as an `Environment=` line of the service unit.
- Never in the source, never in a log line, never in a commit.

Done when every variable of step 4 is set where its job runs.

## 7. Verify the first check-in

1. Run the doctor where the job runs:

   ```bash
   cronheart doctor nightly-backup
   ```

   It reports which variable answered for the monitor, sends a real check-in and
   prints the clock skew against the server. Exit 0 means it found nothing
   wrong. It never prints the id, and it says what it did not check.
2. Run the job once by hand, or wait for one tick, and open the monitor in the
   dashboard: a `start` and a `success` check-in with a duration means the
   adapter is wired; a single heartbeat means only the doctor reached it.
3. Confirm in the dashboard that the monitor has a verified notification
   channel attached. The doctor cannot see this, and a monitor without one
   alerts nobody.

Done when the doctor exits 0 and the dashboard shows the job's own check-in
with a verified channel attached.

## 8. What an error means

### On the check-in path

Nothing throws. Every check-in returns a `PingResult`, `result.outcome` is one
of twelve words, and `describePingResult(result)` writes the sentence for it.
Each failure is also warned once per process per cause per monitor.

| Outcome | Means | Do |
| --- | --- | --- |
| `accepted` | the server recorded it | nothing |
| `duplicate` | recorded, and a retry landed the same check-in twice | nothing |
| `suppressed` | the variable is unset, or the value it holds is not an id, so nothing was sent | set `CRONHEART_<NAME>_UUID` |
| `disabled` | `CRONHEART_DISABLED` is set, so nothing was sent | unset it to resume |
| `not-found` | HTTP 404: the id resolves to no monitor — deleted, rotated or wrong | fix the variable |
| `paused` | HTTP 410: the monitor is paused; check-ins are recorded and no alert fires | unpause it in the dashboard |
| `rate-limited` | HTTP 429: the server refused this check-in; it is never retried | lengthen the schedule, or set `CRONHEART_RETRIES=0` where the limit counts requests |
| `server-error` | a 5xx that the retries did not settle | wait; nothing on the client is wrong |
| `timeout` | the whole budget, retries included, ran out | raise `CRONHEART_TIMEOUT_MS` if the network is slow by nature |
| `network-error` | the request left and was never answered | the network, a firewall, DNS |
| `aborted` | a `signal` the caller passed fired | nothing |
| `unexpected` | a status this client does not know | report it |

`result.sent` says a request left the process; `result.answered` says the
server replied. A refused connection is sent and not answered.

### On the management path

`cronheart/api`, `cronheart init` with a key and `cronheart sync` throw one
type, `CronheartApiError`, for every failure. Check `isCronheartApiError(error)`
— never `instanceof`, which fails across two copies of the package — then
branch on `error.kind`:

| `kind` | HTTP | Means | Do |
| --- | --- | --- | --- |
| `configuration` | — | the client could not be built: no key, a key with a newline attached, a base URL with a query string, plain `http` off loopback | fix the wiring |
| `invalid-request` | — | refused before a request existed: a name past its bounds, an unknown time zone, a non-numeric channel id | fix the request |
| `transport` | — | `error.reason` is `timeout`, `aborted`, `network-error`, `unparseable`, `unbounded` or `unexpected` | the network, or a response that is not JSON |
| `hydration` | 2xx | the response is not the shape this client reads | report it |
| `authentication` | 401 | the key was rejected; a key is shown once and cannot be read back | check the value `CRONHEART_API_KEY` holds |
| `plan-restriction` | 402 | should not happen — every plan includes the REST API now; `error.upgradeUrl` if it somehow does | report it, or take route A |
| `forbidden` | 403 | the monitor limit is reached, or the account's email address is unverified; on signup, signup from the API is switched off | free a monitor, or verify the address; sign up on the web |
| `not-found` | 404 | no such resource in this key's project; a key scoped to another project reads the same | check the id and the key's project |
| `conflict` | 409 | an idempotency key is still reserved, or reused with a different body | read the resource back before deciding it was not created |
| `validation` | 422 | `error.errors` names the fields the service refused | fix those fields |
| `rate-limit` | 429 | the account's API limit is spent; on signup, too many signups for the address or the network, or a poll too soon; `error.retryAfterSeconds` | wait; every key of the account shares one limit |
| `signup-expired` | 410 | the signup expired, was cancelled on the mailed page, or its key was already handed out | run `cronheart signup` again; if the account was made, take a key from its API tokens page |
| `channel-delivery` | 502 | a channel test reached the destination and the destination refused it | the destination, not the API |
| `unexpected` | other | a status this client does not know | report it |

`error.group` is the coarser cut: `response` is everything the server refused,
and `configuration`, `invalid-request`, `transport` and `hydration` are the four
ways a request failed without one.

### From the command line

| Command | Exit | Means |
| --- | --- | --- |
| `cronheart run` | the command's own | the wrapped command's status, passed through |
| | `64` | the invocation could not be read: an unknown flag, no monitor flag, nothing after `--` |
| | `124` | `--timeout` expired |
| | `126`, `127` | the command could not be started; `127` when it is not on `PATH` |
| | `128` + n | the command ended on signal n |
| | `70` | the wrapper failed in a way it did not anticipate |
| `cronheart ping` | `0` | always, so it cannot break the job around it; `1` under `--strict` when the check-in failed |
| `cronheart doctor` | `0`, `1` | nothing wrong, or something is |
| `cronheart init` | `0`, `1` | the check-in was recorded, or it was not |
| `cronheart sync --check` | `0`, `2`, `1` | matches, differs, could not answer |
| `cronheart signup` | `0`, `64`, `1` | the key was written; the terms were not accepted or the invocation could not be read; the service refused, the code expired or was cancelled, or the key could not be written |

A monitor `cronheart run` cannot use — an empty `--uuid` where a variable went
missing, a name behind `--uuid` — is reported on stderr and the command still
runs, unmonitored. `64` means the wrapper could not read what it was asked to
do, and nothing was spawned.

## 9. Do not

- Put `CRONHEART_API_KEY` where the job runs. Check-ins need no key.
- Commit `.env`, or write an id into source, a log line or a commit message.
- Catch around a check-in, or catch a wiring-time error to keep booting.
- Use `npx` in a crontab, or a relative path to the binary.
- Create one monitor per job instance. A monitor is a schedule; a BullMQ queue
  maps job names to monitors and leaves the rest unmonitored on purpose.
