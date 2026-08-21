---
'cronheart': patch
---

A UTC offset is a zone, and three adapters stop calling it nothing.

`cron`, `@nestjs/schedule` and `croner` all take a UTC offset as an alternative
to a zone name — in the first two the type declarations make the pair mutually
exclusive. Nothing in the package read it, so an hour-pinned job scheduled with
an offset drew "no zone was named, so it will fire in <host zone>", which is
false twice over: a zone was named, and the job will not fire in the host's. The
adapters now read the offset as the evidence it is and stay quiet. Presence, not
truth: an offset of zero is UTC, and reading it for truth would advise a job
pinned to UTC that it fires somewhere else.

Worth naming for anyone who wired a Nest job expecting that advice: the
framework hands the adapter a `CronTime`, and `cron` fills that object's zone
with the host's when the caller named neither, so the only case in which the
Nest adapter could ever have spoken was the offset one — the case where it was
wrong. `node-cron` and `node-schedule` offer their callers no offset at all.

The contract now has something watching the service rather than only itself.
`contract:drift` compares the wire contract against a snapshot of the published
API specification committed in this repository — offline, on every pull request,
so a service that cannot be reached can never turn a review red. Each difference
is classified through the rule table the repository already documents, so a
removal, a rename or a narrowed bound fails while an addition an open vocabulary
was tagged to tolerate does not; the job refuses to run at all if the rules it
holds and the rules that table documents have parted. The fetching half runs on
a schedule and opens a pull request when the specification moves. Both halves
print what the specification cannot see — the whole check-in route and most of
the validation surface — in the contract's own words, rather than implying a
coverage neither has.
