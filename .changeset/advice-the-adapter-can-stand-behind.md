---
'cronheart': minor
---

The node-cron adapter takes the zone you passed to the scheduler, and stops
advising on one it cannot see.

`monitor(task, name, { timezone })` declares the zone the task was created with,
so an unknown one is refused at attach time exactly as it is for the adapters
that read the scheduler's own options. node-cron exposes none of a task's
options, so until now the adapter advised "no zone was named, set node-cron's
timezone option" on every hour-pinned pattern — including the ones whose owner
had set it, and including the package's own node-cron sample. Declare nothing
and the adapter now says nothing: advice given without evidence is what teaches
people to ignore the channel it arrives on.

The README no longer quotes a measured size for the ping entry. The ceiling the
gate holds is quoted instead, and a test fails on any other size in bytes
appearing there, so the documented number cannot drift away from the measured
one as the previous one had.
