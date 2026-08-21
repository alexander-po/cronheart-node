---
'cronheart': minor
---

Adapters for BullMQ and `@nestjs/schedule`, completing the set of six.

The queue adapter wraps the processor rather than the worker's events, so a
check-in is tied to the job name that asked for one and nothing is sent for the
rest of the queue. It hands back the worker's own argument list, which is what
lets it read the parallelism the worker actually runs under. Three things a queue
does that a scheduler does not are handled in code rather than in prose: a
failure is reported only once the job has exhausted the attempts it was given, a
job that is not on a repeating schedule is left alone with one warning naming it,
and above a concurrency of 1 the start check-in is off by default, because
parallel runs of one job name would interleave the starts of runs that are
separate.

The NestJS adapter is a module rather than a decorator. `CronheartModule.forRoot()`
walks the scheduler's registry once the application has booted and wraps every
registered job the mapping names, so no call site changes and no decorator has to
sit in the right place — and at startup it writes one line saying what it covers,
`monitoring 3 of 5 cron jobs; unmapped: cleanupTmp, warmCache`, so a job nobody
monitors is visible rather than silent. The framework's own `SchedulerRegistry`
class goes in as the injection token, because the module imports nothing of the
framework at runtime.

The peer floor run now moves the halves of a framework in step with the peer it
pins, since a framework with one half at its floor and the other at head does not
load at all.
