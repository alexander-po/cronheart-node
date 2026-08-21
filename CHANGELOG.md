# Changelog

All notable changes to the `cronheart` package land here, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/) — with the `0.x` caveat
written down rather than assumed: until `1.0.0`, a minor may break the public
surface and a patch never will.

Entries are generated from changesets — run `make changeset` alongside the
change rather than editing this file by hand.

## 0.1.0

The first release. Everything here is new, so there is nothing to upgrade from;
what follows is what the package does, grouped by the surface it does it on.

`cronheart` is the official Node and TypeScript SDK for
[cronheart.com](https://cronheart.com): a scheduled job checks in over HTTP, and
the service alerts when one stops checking in on time. Zero runtime
dependencies, ESM and CommonJS, Node 22 or newer. The check-in path is bundled
apart from everything else, so a production bundle carries only the part it
uses.

### Checking in

- `checkIn`, `withMonitor`, `startRun`, `checkInWith` and `createPingClient`.
  `withMonitor` is defined as `startRun` with the job handed in, so the two
  brackets cannot diverge: both dispatch the start check-in without awaiting it,
  and both layer the run's options under the terminal call's own.
- **A check-in never throws and never rejects.** Every path returns a
  `PingResult` — `outcome`, `ok`, `sent`, `answered`, `status`, `attempts`,
  `durationMs` and a `message` written for the outcome. The guarantee is
  mechanical: one `safely()` chokepoint covering name resolution, URL
  construction, option reading and body encoding as well as the request; a
  source guard that fails the build on a network call, a `throw` or a rejected
  promise outside the layer that owns them; an unhandled-rejection assertion
  across the suite; and a fault matrix over how the transport misbehaves, how
  the deployment is misconfigured and what the calling program hands in, with a
  deliberately unsafe control proving the matrix can go red.
- **Configuration mistakes surface at wiring time instead.** An unresolvable
  monitor name fails where the client is built, so a typo fails the deploy
  rather than going quiet at three in the morning. A value shaped like an
  identifier the whole way through is diagnosed as a broken identifier, and no
  environment variable is looked up for one. The module-level `checkIn`,
  `withMonitor`, `startRun`, `checkInWith`, `flush` and `monitors` build their
  client on first use, which is inside the job rather than at a wiring moment
  of their own — so a `CRONHEART_URL` no client can be built from reaches them
  as a `suppressed` outcome naming the problem, and the job still runs. The
  client that refuses carries the host's own environment and everything defined
  against it, so it names the base URL rather than a monitor variable that is
  already set, and `monitors.has` still answers for one.
- Names resolve from an explicit map or from `CRONHEART_<NAME>_UUID`, and a raw
  identifier is accepted anywhere a name is. `CRON_MONITOR_*` is read for every
  variable, permanently.
- Retries are capped and paced by a floor delay; the timeout is one budget
  across every attempt and every delay between them, and it covers the response
  read rather than only the request. A 5xx already in hand is reported as itself
  when that budget runs out, and an abort the caller asked for is reported as
  `aborted` rather than as a deadline nobody set.
- The base URL is validated where the client is built — a query string, a
  fragment, a credential, a scheme that is not http(s), and plain `http` to
  anything but an anchored loopback address are all refused there, because a
  check-in that lands on the site root answers 200 and is recorded as accepted
  forever. A redirect is never followed: the specification would turn the `POST`
  into a `GET` and drop the body.
- Bodies are truncated byte-exactly with redaction applied first, and the
  runtime header rides on terminal check-ins only, omitted rather than clamped
  when the measured runtime falls outside the range the service accepts.
- Ships `cronheart/testing` — a ping recorder that can also refuse to have its
  body read, and a reset for the once-per-process warning ledger.

### Schedulers

- Six adapters, each a subpath export whose scheduler is an optional peer
  imported for its types only: croner, `cron`, node-cron v4, node-schedule,
  BullMQ and `@nestjs/schedule`. Nothing is required at runtime and no adapter
  constructs the scheduler's objects.
- Four of the six hand the scheduler back what it was given — three as its own
  argument list, cron as its own parameters object with only the tick replaced —
  which is what makes the schedule the monitor is checked against the schedule
  the scheduler runs. node-cron attaches to its v4 execution events instead,
  because a callback wrapper cannot see a file-path or background task at all;
  the NestJS adapter is a module that walks the framework's registry once the
  application has booted, so no call site changes.
- A monitored run brackets the job with `start` and then `success` or `fail`,
  carrying the duration, hands the job's own value back by identity and rethrows
  its error as the same object.
- Overlapping runs are reported as one, failed if any of them failed, with one
  warning naming the scheduler's own guard — `protect`, `waitForCompletion`,
  `noOverlap`, or the absence of one.
- A six-field cron expression, an alias only the scheduler resolves, an unknown
  time zone and a monitor nothing resolves are all refused where the job is
  wired.
- A schedule pinned to an hour of the day with no zone named warns once, saying
  which zone it will fire in — and only where the adapter can see whether one was
  named. A UTC offset counts as a zone, so the three schedulers that take one
  instead of a name draw no such warning; node-cron exposes none of a task's
  options, so `monitor(task, name, { timezone })` is how a zone is declared there
  and saying nothing leaves the adapter silent rather than guessing.
- The queue adapter wraps the processor rather than the worker's events, so a
  check-in is tied to the job name that asked for one. A failure is reported only
  once the job has exhausted its attempts, a job that is not on a repeating
  schedule is left alone with one warning naming the monitor it was mapped to,
  and above a concurrency of 1 the start check-in is off by default, because
  parallel runs of one job name would interleave the starts of runs that are
  separate.
- NestJS writes one line at startup saying what it covers —
  `monitoring 3 of 5 cron jobs; unmapped: cleanupTmp, warmCache.` — so a job
  nobody monitors is visible rather than silent, and one whose callback the
  scheduler does not expose gets a clause of its own rather than being passed
  off as monitored.

### The command line

- `cronheart run`, `ping`, `doctor`, `init` and `sync`, plus a `--help` page per
  command with examples that work from a crontab.
- `run` wraps a command and exits with that command's own exit status. A
  check-in that fails writes one line to stderr and changes nothing else, and a
  monitor the wrapper cannot use — an empty flag value, a value behind `--uuid`
  that is not an identifier at all, a name behind `--uuid` — runs the command
  unmonitored rather than trading a working nightly backup for a diagnosis. `64`
  is reserved for an invocation that could not be read at all.
- A non-zero run writes its summary to stderr, so cron mails it the way it would
  have mailed the unwrapped command's own error; a successful run writes no
  summary. `ping` is silent on a check-in that worked, in the shape of
  `curl -fsS`.
- Both of the command's streams are teed rather than captured, so a crontab's
  redirect keeps working while the last `--output-bytes` ride along with the
  check-in. The tee honours the parent's backpressure, and `--output-bytes=0`
  inserts no pipe at all.
- **The excerpt is redacted before anything cuts it** — at the write that splits
  a token in two, at the ring that bounds memory, at the byte budget and at the
  body cap — so truncation can only split a `[redacted]` marker rather than strip
  the anchor off a secret and leave the secret behind, within the 2 KiB of the
  stream redaction reaches back at each of those boundaries. `--redact` and
  `CRONHEART_REDACT` add patterns; a pattern that does not compile is a usage
  error on the command line, and withholds the excerpt entirely in the
  environment variable, where one typo would otherwise stop every wrapped job on
  a machine.
- The command leads its own process group when there is no controlling terminal
  to lose, so `--timeout` (exit `124`, matching `timeout(1)`) and the signals
  reach a shell script's children; run from a terminal it does not, because that
  would cost a `sudo` or `ssh` prompt its `/dev/tty`.
- The terminal check-in and its flush share one 2 s budget, after which the
  status already in hand is returned.
- `doctor` reports the resolved configuration, which variable answered for the
  base URL, the kill switch and each monitor, a real check-in and the clock skew
  — never a monitor identifier — and names what it did *not* check, so a clean
  report is not read as reassurance about alerting.
- An identifier is cut to its last four characters wherever a flag refuses one:
  behind `--name`, where a name was what belonged there, and behind `--uuid`,
  where a real identifier is passed and a trailing line break, a leading space
  or a copied GUID's braces is what made it unusable. The refusal names what
  came with the value rather than quoting it, because the value is a working
  check-in capability and the line prints on every tick into cron's mail.
- `init` writes `CRONHEART_<NAME>_UUID` with owner-only permissions, through a
  temporary file and a rename, refusing to follow a symbolic link; it creates the
  monitor when an API key is configured and matches by name first, and falls back
  to a pasted identifier on the free path.

### The management API

- `cronheart/api` — `api.monitors.*`, `api.channels.*` and `api.account.get()`
  over the REST API. It is the inverse of the check-in client: **it always
  throws**, and every failure arrives as a `CronheartApiError`, so one `catch` is
  exhaustive.
- Errors carry a `kind` discriminant that narrows to the fields that kind carries
  — a validation failure's field map, a rate limit's guidance, a plan refusal's
  upgrade link, a transport reason — and a `Symbol.for` brand check that survives
  two copies of the package in one dependency tree, which `instanceof` does not.
- The API key is validated when the client is built, travels only in the
  `Authorization` header, is refused over plain `http` to anything but an
  anchored loopback address, and appears in no message, log line, `toJSON` or
  error `cause`. A monitor identifier never reaches a message either: a request
  is reported as `GET /api/v1/monitors/{uuid}`.
- The three pagination shapes are surfaced as three different things, because
  they are not interchangeable: offset listings as async iterators that drop the
  rows a tiebreaker-less ordering repeated, the pings cursor as an iterator that
  stops when a cursor comes back twice, and the channels listing as a single call
  over the whole set.
- A request the service is certain to refuse is refused here first, naming the
  field the value came from; every bound it checks against is exported, so a form
  you validate yourself reads the same numbers.
- Retries share one bounded attempt count with the check-in transport, branded so
  that no loop can obtain an unbounded one. A create is retried only with an
  `idempotencyKey`, and a blank key counts as no key, because that is what the
  service does with one.

### Declarative sync

- `cronheart/sync` and `cronheart sync` reconcile the monitors of one project
  against a file that is only ever read. `defineMonitors` absorbs the wire's
  sharp edges: a five-field string is a cron expression, one of the twelve fixed
  tokens is a preset, and `{ every: '5m' }` becomes the whole number of seconds,
  written as a string, that the service actually wants.
- Identity is by name, because that is all that is available. Two of one name in
  the file is an error at parse time, before a credential is read; two on the
  service is a conflict, reported and skipped; the offset listing is treated as
  advisory; and every create carries a deterministic `sync-<sha256>` key so that
  a repeated run inside the service's replay window cannot mint a duplicate.
- **Three ways a reconciler can silently switch off alerting are closed
  structurally.** The routing field replaces wholesale when present and is left
  alone when absent, so `channels` has three states written down rather than
  inferred; an empty list is refused, because that is the shape a defaulted value
  takes. A create *or* update whose channels resolve to nothing verified is
  refused unless the file wrote `'none'`. And a channel reference of digits is
  matched against labels as well as identifiers, because `"911"` is a legal
  label.
- **Deleting waits for the constructive half.** Orphans are reported and never
  deleted by default; pruning takes `--apply --prune` and a confirmation, is
  refused outright while anything else in the run failed, and is refused for a
  file that describes no monitors at all — a glob that matched nothing and a
  truncated write both arrive looking exactly like an instruction to empty the
  project. The sentence saying how many of how many would go is printed before
  any delete, so `--yes` does not skip the only record the run leaves.
- `--check` has three answers, not two: `0` when the account matches, `2` while
  anything differs, `1` when the run could not answer the question at all.
  Under `--print-env`, stdout carries the `CRONHEART_<NAME>_UUID` assignments and
  nothing else.

### What using it taught

The `0.x` line exists so that real use can correct API mistakes before anyone is
owed a stability guarantee. Migrating a working consumer onto the package before
publishing it produced eleven corrections, all of them in this release:

1. **A failed check-in says so by itself.** The built-in warner spoke only for
   the four configuration outcomes, so a refused connection with no `onResult`
   produced no output at all — a heartbeat could fail forever with nothing to
   show for it.
2. **`describePingResult` is exported**, so replacing the warner with a logger is
   two lines rather than a switch over the outcome vocabulary.
3. **`isMonitorId` is exported**, for validating identifiers at
   configuration-load time without keeping a copy of the pattern.
4. **`answered` is on `PingResult`.** A refused connection reports `sent: true`
   with no status, and telling that from a refusal the server sent was an
   inference the type did not advertise.
5. **A value shaped like an identifier is diagnosed as a broken identifier**, not
   as a name whose variable nobody set — screaming a mistyped identifier into a
   variable name turned a typo into a search of the environment.
6. **A monitor the wrapper cannot use no longer costs you the job.**
   `cronheart run --uuid=$VAR` in a crontab whose variable went missing used to
   exit `64` without spawning the command; it now reports on stderr and runs it
   unmonitored.
7. **`--action=heartbeat` is accepted**, which is what the library sends when no
   action is named.
8. **`PING_ACTIONS` and `PING_EMITTABLE_ACTIONS` are exported**, so a caller
   generating the flag can check the value before passing it.
9. **`--version` names the package on npm** rather than the repository it is
   built from. The User-Agent keeps the language, where a server log has to tell
   the SDKs apart.
10. **The command-line tool is reachable by a specifier**, `cronheart/cli`, so a
    container build can resolve and copy it instead of requiring a global
    install. Importing it deliberately does nothing.
11. **Every check-in is a `POST`**, with or without a body. `GET` is the one verb
    a cache or a scanning intermediary may answer on the service's behalf, and a
    check-in answered by an intermediary is reported as accepted while the
    service never saw it — the single failure a monitoring client cannot detect
    from its own result.

### Wire contract

The repository carries a machine-readable wire contract, at version **2.2.1** for
this release, read out of the running service rather than inferred from its
documentation. Constant-equality checks and language-neutral conformance vectors
run against it on every build, a drift watch compares it against a committed
snapshot of the published API specification on every pull request and against the
running service on a schedule, and the contract version rides in the User-Agent
alongside the SDK version, so a support request names what the client was built
against. It is not part of the published package.
