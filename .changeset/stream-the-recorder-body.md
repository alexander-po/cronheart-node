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
still there for a caller that wants it. The recorder's own surface is unchanged
— the same `respondWith`, the same `pings`, the same `undrainedBodies` — but a
test of yours can change colour, and that is the point of the fix rather than a
caveat: a check-in through the recorder is now read under a cap, released
through the reader, and a wrapper of yours that intercepted `text()` stops
firing. The double stays deliberately permissive where a real response throws:
it hands out a second reader and answers `text()` after the stream is drained,
so a test that does either keeps working.
