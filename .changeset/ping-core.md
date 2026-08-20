---
'cronheart': minor
---

Ping core: `checkIn`, `withMonitor`, `startRun`, `checkInWith` and
`createPingClient`, all of which return a `PingResult` outcome rather than
throwing. Name resolution through an explicit map or `CRONHEART_<NAME>_UUID`,
with a raw id accepted anywhere a name is and an unresolvable name failing at
wiring time. `withMonitor` is defined as `startRun` with the job handed in, so the two
brackets cannot diverge: the start check-in is dispatched without being awaited
in both, and the terminal one carries the run's options layered under the
terminal call's own. Retries capped and paced by a floor delay, a timeout that
is one budget across every attempt and every delay between them, a 5xx already
in hand reported as itself when that budget runs out, a caller-initiated abort
reported as `aborted` rather than as a deadline, a base URL validated at wiring time,
byte-exact body truncation with redaction applied first, and the runtime header
on terminal check-ins only, omitted rather than clamped when the measured
runtime falls outside the range the server accepts. Ships
`cronheart/testing` with a ping recorder and a reset for the once-per-process
warning ledger, the conformance-vector runner over the wire contract, and a
fault matrix with a negative control that proves it can fail. The package root
exports what a consumer uses — the action and outcome vocabularies, the body
cap, the versions and the errors; the wire constants the contract anchors are
read from a build-time module that is never published.
