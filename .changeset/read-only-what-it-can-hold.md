---
'cronheart': patch
---

Two fixes `0.1.2` needed and did not have, a security fix that came out of
reviewing them, and the corrections around them. **Upgrade from any earlier
`0.1.x`**: a check-in's error could carry the monitor id wherever the `fetch`
in use names the request it failed on.

- **A check-in's error no longer carries what your transport rejected with.**
  `result.error.cause` was the rejection itself, and a transport that names the
  request it failed on — node-fetch does, as `request to <url> failed` — names
  the monitor id with it, which is the whole credential on the check-in route,
  and so does any other `fetch` whose rejection names the URL. Anything logging
  `result.error` with its cause chain logged the id. Affected
  versions are `>=0.1.0 <0.1.3`. The outcome still says what happened; the
  host's own wording is no longer attached.
- **A check-in through `createPingRecorder` now settles on fake timers, for
  every reply that is neither retried nor given a `delayMs`.** The read loop gave the event loop a timer
  turn after every piece under 64 bytes, and the recorder answers in a single
  piece, so every stubbed reply waited on a timer `vi.useFakeTimers()` never
  fires. The loop now gives the deadline its turn every 1024 pieces, whatever
  their size. A retried reply — a `5xx` or a refused connection while retries
  remain — still waits out its retry delay, so a fake clock has to be moved
  past it. The same change takes a timer tick per small piece off a real body,
  which used to reach its deadline before its cap when it arrived a byte at a
  time, and gives the deadline a turn inside a long run of large pieces, which
  never yielded at all.
- **A body that arrives as a Node stream is read under the cap.** node-fetch
  hands one back, with no reader on it, so `0.1.2` read it whole through
  `text()`: the unbounded read that release fixed for the built-in `fetch`. The
  request behind a body cut short at the cap is let go once the check-in is
  done, rather than held open until the far side ends it.
- **A reply whose stream will not hand over a usable reader is no longer read
  whole.** `0.1.2` fell back to `response.text()` when `getReader()` threw. A
  real `Response` in that state refuses both, so the fallback only ever reached
  a transport offering the unbounded read the cap exists to avoid. The reply is
  now classified the way any body that could not be read is: by its status,
  which for a `2xx` is an accepted check-in.
- **What is kept of a body read whole is cut to the same cap.** A `fetch` that
  offers only `text()` is still read whole, which is the trade it makes. The
  management client now reports such a body over `API_RESPONSE_BODY_CAP_BYTES`
  as `unbounded` instead of parsing it.
- **A signal is read the same way everywhere.** A value that only looks like an
  aborted signal no longer turns a held server error into `aborted`, and a
  signal that throws when inspected no longer stops the check-in from being
  sent while reporting it as a network error.
