---
'cronheart': minor
---

Ping core: `checkIn`, `withMonitor`, `startRun`, `checkInWith` and
`createPingClient`, all of which return a `PingResult` outcome rather than
throwing. Name resolution through an explicit map or `CRONHEART_<NAME>_UUID`,
with a raw id accepted anywhere a name is and an unresolvable name failing at
wiring time. Bounded retries with no backoff, a timeout that is one budget
across attempts, byte-exact body truncation with redaction applied first, and
the runtime header on terminal check-ins only. Ships `cronheart/testing` with a
ping recorder, the conformance-vector runner over the wire contract, and a
fault matrix with a negative control that proves it can fail.
