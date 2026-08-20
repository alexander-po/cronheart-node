---
'cronheart': minor
---

The loopback allow-list is anchored. `localhost.attacker.example`,
`localhostile.example.com` and `127.attacker.example` all passed an unanchored
prefix test as loopback, so plain `http` was permitted to a host anyone can
register — and the account-wide bearer token then travelled to it in the clear,
in the request the check exists to prevent. The same test was cloned byte for
byte into the check-in path, where it leaked a monitor identifier instead. Both
now demand an exact `localhost`, an exact IPv6 loopback literal or a real
`127.x.x.x`, and the policy, the userinfo stripping and the whole base-URL check
live in one module both clients import rather than in two copies that drifted.

Two credentials no longer reach an error message. A request is now described as
`GET /api/v1/monitors/{uuid}`: the monitor identifier is the check-in
capability, and it was interpolated into the message of every classified error
on ten of the fourteen monitor methods, and carried on an enumerable property
that `JSON.stringify` and any structured logger picked up as well. And a refused
base URL is quoted back as origin plus path only, with a fixed sentence when it
does not parse at all — a key parked in a query parameter was previously
repeated verbatim by the refusal.

Nothing leaves the management client unbranded any more. The request body is
serialised inside the guarded region, and the four channel destination fields
are validated like every other field, so a `BigInt`, a circular structure or a
throwing `toJSON` is refused rather than escaping as a raw `TypeError`. The
options object is read inside the same seal, and a base URL that is not a string
is refused rather than coerced.

The idempotency key and the user agent are validated before they reach a header.
A value carrying `CRLF` could inject arbitrary headers — including a second
`Authorization` — into the one request that carries the key, on any custom
transport; a non-string produced a garbage header rather than a refusal. A blank
key now counts as absent for both the header and the retry decision, because the
service reads an empty key as no key at all: a retry after a lost response would
otherwise create a second monitor, silently spending the plan budget and leaving
a duplicate alerting on the same schedule.

The retry cap can no longer be talked past. The management client passed zero
retries into the capped transport and ran its own uncapped loop, so
`CRONHEART_RETRIES=40` issued 41 requests against an API with per-account rate
limits, and the README's two "capped at 5" sentences were false. There is now
one bounded attempt count, branded so that no loop can obtain an unbounded one,
and a source-guard rule fails the build on a third loop deriving its own.

Contract 1.5.0 states the idempotency key's maximum length and records that an
empty key is read as no key.
