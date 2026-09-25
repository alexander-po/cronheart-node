---
'cronheart': patch
---

The service now includes the REST API on every plan, Free included, each at
its own rate limit — 30 requests/min on Free, 120 on Starter, 300 on Growth,
600 on Scale. This package no longer tells a reader the API needs Starter or
above: `cronheart init`, `cronheart sync --help` and the README say what is now
true instead, and `cronheart doctor` no longer mentions a plan beside a
configured key.

`ApiPlanRestrictionError` and `error.kind === 'plan-restriction'` are kept —
the wire contract still defines HTTP 402 as a possible answer, and a 402 must
still classify as something rather than fall through to
`ApiUnexpectedResponseError` — but the class is now `@deprecated`: no plan is
denied any more, so a caller should not expect to see one. Its message, and
the one `cronheart/sync`'s error reporting gives for the same `kind`, now say
a 402 should not happen under the current plans rather than naming a plan to
upgrade to.
