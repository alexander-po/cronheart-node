---
'cronheart': minor
---

Make four guards able to fail, and correct two contract statements.

The contract check read the SDK's *built* exports, so a wire literal that was
simply never re-exported was invisible to it — which is how seven of them, the
name and label bounds, the schedule-expression and timezone lengths, the grace
minimum and the cron alias list, sat outside a check whose whole purpose is to
make an unanchored literal impossible. It now reads the source as well, so every
SCREAMING_SNAKE constant declared anywhere under `src/` is either stated by a
contract anchor or recorded, with a reason, as not being a wire fact. All seven
are now anchored, along with the four per-kind channel requirement lists, and
every bound is exported from `cronheart/api` so a consumer validating its own
form reads the same numbers this client does.

The rule keeping the check-in path away from the management client matched only
single-quoted static imports, so the double-quoted, side-effect, dynamic and
`require` forms all passed — a type-only import, which erases at build time, was
caught while a dynamic import of the whole client was not. All five forms are
matched now, and a transitive route is followed through the import graph and
reported as the path it took.

The undrained-response-body counter in `cronheart/testing` could not move: the
recorder marked a body consumed inside the read, and the transport reads every
response. A consumer asserting their code leaks no bodies got a reassurance that
was structurally incapable of failing. Both that recorder and the one behind the
management-client tests now take `readRejectsWith`, so a body can arrive and
refuse to be read, and the assertion means something in both places.

Two contract statements were wrong. The alert listing **does** break its
ordering tie on the identifier and is a total order — only the monitor and
channel listings lack one, so a port reading this no longer builds deduplication
it does not need. And a **missing** page limit takes the default of fifty; it is
a limit that is present but not numeric that coerces to zero and is then raised
to one. This client is unaffected because it always sends an explicit limit, but
a port that trusted the old sentence would size every page at one.

Alongside those: a 429 from the two routes that carry throttles of their own no
longer claims the account's API limit is exhausted while the reading beside it
says otherwise; a channel-delivery failure keeps the rate-limit reading every
other refusal carries; an unknown time zone is refused locally and names `tz`,
rather than arriving from the service against the schedule expression; a channel
missing the field its kind requires is refused before the request exists; name
and label bounds are counted in characters, as the service counts them, rather
than in UTF-16 code units; the integer hydrator rejects a fractional value; and
`api.rateLimit()` is a function, so it survives being destructured off the
client the way every other member already did.

Contract 2.0.0. The page-limit correction is a `breaking-both` change under the
repository's own classification table — a pager reads the clamp to size its
requests — so it takes the major even though the service never moved.
