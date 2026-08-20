---
'cronheart': minor
---

Add `cronheart/sync` and `cronheart sync`, which reconcile the monitors of one
project against a configuration file.

`defineMonitors` absorbs the wire's sharp edges: a five-field string is a cron
expression, one of the twelve fixed tokens is a preset, and `{ every: '5m' }`
becomes the bounded whole number of seconds written as a string that the
service actually wants. A six-field expression is refused with a message naming
the dialect it came from, since the schedulers people use accept a leading
seconds field and this service does not.

Identity is by name, which is all that is available: there is no upsert, no
exact-name filter and no uniqueness constraint. So two monitors of one name in
the file is an error at parse time, before a credential is read; two on the
service is a conflict, reported and skipped; the offset listing is deduplicated
and treated as advisory; and every create carries a deterministic
`sync-<sha256>` key derived from its own request, so a repeated run inside the
service's replay window cannot mint a duplicate even when the listing failed to
report the monitor. That window is what the service underwrites and no more.
The key is derived with Web Crypto — the entry imports nothing from `node:`.

Two ways a reconciler can switch off someone's alerting are closed
structurally. The routing field replaces wholesale when present and is left
alone when absent, so `channels` has three states written down rather than
inferred — a list, the word `'none'`, or absent, which manages nothing. An
empty list is refused, because that is the shape a defaulted value takes. And a
create whose channels are empty or all unverified is refused unless the file
wrote `'none'`, with every plan row printing what it will alert.

`--check` exits 2 while anything differs, which is what turns the file into
something a build can test. Orphans are reported and never deleted; pruning
takes `--apply --prune` and a confirmation. `--print-env` emits the
`CRONHEART_<NAME>_UUID` lines. The configuration file is only ever read.

`cronheart init` now creates the monitor when an API key is configured:
attaching the account's verified channels, writing the variable and sending the
test check-in. The free path is unchanged, and every paid-only message is still
a sentence this package holds rather than the service's own detail string.
