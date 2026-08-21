---
'cronheart': minor
---

Scheduler adapters for croner, cron (the package named `cron`, from the
`kelektiv/node-cron` repository), node-cron v4 and node-schedule.

Each is a subpath export whose peer is declared optional and imported for its
types only, so nothing is required at runtime and no adapter constructs the
scheduler's objects. Three of the four hand back the scheduler's own argument
list — `new Cron(...monitored(…))`, `CronJob.from(monitored(…))`,
`scheduleJob(...monitored(…))` — which is what lets the schedule the monitor is
checked against be the schedule the scheduler runs. node-cron attaches to its v4
execution events instead, because a callback wrapper cannot see a file-path or
background task at all.

A monitored run brackets the job with a `start` and a `success` or `fail`
check-in carrying the run's duration, hands the job's own value back by identity
and rethrows its error as the same object. Overlapping runs are reported as one,
failed if any of them failed, with one warning naming the scheduler's own guard
— `protect`, `waitForCompletion`, `noOverlap`, or the absence of one. A
six-field expression, an alias only the scheduler resolves, an unknown time
zone and a monitor nothing resolves are all refused where the job is wired.

A new `min-peers` CI job compiles and runs the adapter suite against the lowest
version each declared peer range admits, on the Node floor.
