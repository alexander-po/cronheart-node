---
'cronheart': patch
---

**`createPingRecorder` now answers through a stream, the way a real response
does.** The recorder handed back a body with no `getReader` and a whole-body
`text()`. Since the check-in path started reading responses under a cap, it
prefers a reader off `response.body` and falls back to `text()` only where
there is no stream — so a check-in through the recorder took a path a check-in
through a real `fetch` never takes, and a consumer testing their integration
against it saw uncapped reads and different release semantics than production.

The stubbed body now arrives through a reader, `bodyUsed` reports the response
as disturbed from its first read rather than from its last, and `text()` is
still there for a caller that wants it. Nothing in the recorder's own surface
changed: the same `respondWith`, the same `pings`, the same `undrainedBodies`.
