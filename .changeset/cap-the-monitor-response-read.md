---
'cronheart': patch
---

**A monitor's reply is now read under a cap.** The check-in path read the
response body whole. Node's `fetch` asks for compressed encodings and
decompresses transparently, so a few megabytes on the wire became gigabytes of
heap, bounded only by the request timeout — anything able to answer for a
monitor could drive the *host* process out of memory inside a five-second
budget. Where the heap held out, V8's own limit on the length of a string did
not: the `RangeError` it throws was swallowed by the read's own `catch`, which
left an empty body behind — and an empty body is how a duplicate check-in comes
back reported as accepted. A scheduler that is OOM-killed by its monitor has
been broken by it as surely as by a thrown exception, which is the one thing
this package promises cannot happen.

At most `PING_RESPONSE_BODY_CAP_BYTES` of a reply is now retained and the rest
of the body is cancelled. The bound is on the response stream, which is what
every runtime this package supports hands back; a `fetch` you supply yourself
that answers only through a whole-body `text()` is still read the way it
answers. Nothing on the wire changes and no result you read changes — the reply
only ever has to tell an accepted check-in from a duplicate one, and the cap
sits far above any answer the service sends. What does change is what this
package asks a `fetch` for: it now takes a reader off `response.body` where it
called `response.text()`, so a hand-written transport or a test double of your
own is exercised through its streaming half for the first time. If yours
implements only `text()`, it still works and gives up the cap in exchange. What is new on the surface
is additive: `PING_RESPONSE_BODY_CAP_BYTES` beside `PING_BODY_CAP_BYTES`, which
caps what a check-in sends, `API_RESPONSE_BODY_CAP_BYTES` on `cronheart/api`,
and the `PingResponseBody` and `PingResponseBodyReader` types a hand-written
`fetch` implements.

The management client shares this transport and is now bounded too, under
`API_RESPONSE_BODY_CAP_BYTES`, far above the largest page the service returns —
one cap for both would have truncated the page — and it says so when a body it
cut short is what failed to parse, rather than reporting the service as having
answered badly. That refusal reuses the `unbounded` reason, which until now meant
only a listing this client stops walking; both are the same statement, that the
client stopped rather than read without bound.

Affected versions: `>=0.1.0 <0.1.2`. There is no backport to an earlier line.
Reported by an independent security review of a consumer that had worked around
it with its own `fetch`.
