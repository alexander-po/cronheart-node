---
'cronheart': minor
---

Add `cronheart/api`, the management client for the REST API.

`createCronheartApi({ apiKey })` exposes `api.monitors.*`, `api.channels.*` and
`api.account.get()`. It is the inverse of the check-in client: every failure —
a refused request, a connection that never opened, a body that is not JSON, a
response it cannot read — arrives as a `CronheartApiError`, so one `catch` is
exhaustive. Errors carry a `kind` discriminant and a brand check that survives
two copies of the package in one dependency tree.

The three pagination shapes are surfaced as three different things: offset
listings as async iterators that drop rows a tiebreaker-less ordering repeated,
the pings cursor as an async iterator that stops when a cursor comes back
twice, and the channels listing as a single call over the whole set, which is
deliberately not an iterator.

The API key is validated when the client is built, travels only in the
`Authorization` header, is refused over plain http to anything but loopback,
and appears in no message, log line, `toJSON` or error `cause`.
