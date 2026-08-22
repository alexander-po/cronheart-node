---
'cronheart': patch
---

**A cancellation that lands while the reply is being read now reports
`aborted`.** It reported `accepted`. Once the response headers were in hand,
nothing re-read the caller's signal: the body read ended on the abort, whatever
had arrived by then was classified, and an empty or partial body classifies as
an accepted check-in — so a shutdown could report a check-in the caller had
cancelled, and a duplicate could come back as an accepted one.

If you branch on `result.outcome`, this is the one behavioural change: a call
you aborted mid-reply now lands in the same `aborted` branch as one you aborted
before it left — including one where the server had already answered with a
`5xx`, which without a cancellation is still reported as `server-error` with its
status. The two rules point opposite ways on purpose: a deadline is something
that happened to the check-in and its answer is worth keeping, while a
cancellation is something you asked for. Nothing else moves — a deadline is
still `timeout`, and an answer read to the end while nobody cancelled is still
classified from what the server said.
