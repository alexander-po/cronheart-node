---
'cronheart': minor
---

Make `error.kind` narrow, seal the check-in client's options, and let a read be
written back.

Every error class the management client throws now declares its own `kind`, and
the brand check narrows to a union of them — so the check the README documents
(discriminate on `kind`, not `instanceof`) reaches the fields that kind carries:
a validation failure's field map, a rate limit's retry guidance, a plan
refusal's upgrade link, and the transport reason, which is the only way to tell
a timeout from a dead socket. `error.group` is the coarser cut, so "the server
refused this" is one check rather than an `instanceof` against a base class.

`createPingClient` now refuses an options object it cannot read the way
`createCronheartApi` does: a base URL that is not a string, and a throwing
getter on any option, come back as `CronheartConfigurationError` rather than
escaping as a raw `TypeError` into the job being monitored.

Write vocabularies — schedule kinds, channel kinds — are typed as openly as the
read side, so reading a monitor, changing one field and writing it back
compiles. An unknown member is still refused by name before a request exists.

The size budget is measured on the minified, gzipped ping entry rather than the
unminified one, because minified is what a consumer's bundler produces and what
their users download.
