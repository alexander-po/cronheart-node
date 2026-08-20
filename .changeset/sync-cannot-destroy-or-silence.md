---
'cronheart': minor
---

Make the reconciler unable to destroy history it cannot replace, and unable to
silence a monitor without saying so.

**Pruning waits for the constructive half.** Deleting is the irreversible half
of a run, so it is now conditional on the rest of the run having landed: a row
the plan refused, a create the service rejected and a request that never
arrived all stop it, and the confirmation is not offered at all rather than
offered and then honoured. A configuration that describes no monitors stops it
too — a glob that matched nothing, a truncated write and a list built from an
unset variable all arrive looking exactly like an instruction to empty the
project, and an empty file is far more often one of those. The sentence saying
what deleting costs, and how many of how many monitors would go, is printed
before any delete rather than only alongside the question, so `--yes` no longer
skips the only record the run leaves. A result now reads reason-first: the line
that says what was deleted no longer frames what went wrong as detail.

**An update can no longer silence a monitor.** The refusal that covered a
create whose channels resolve to nothing verified now covers an update too — a
file that names channels and resolves to nothing verified is this run silencing
the monitor, whether it existed beforehand or not. Silence that was already
there when the run started stays a report, because closing it would move a
field nobody wrote down, and `'none'` remains the way to ask for it on purpose.
Rows that alert nobody are marked and counted in the tally instead of being
readable only as trailing prose.

**A monitor that cannot alert says so.** A paused monitor is never scanned for
lateness and a live snooze suppresses delivery, so a plan that listed their
channels was promising something the service does not do. Both now render the
reason in place of the channel list. Neither is a managed field, so this is a
report correction and not a diff.

**A channel named by digits is not assumed to be an identifier.** A label is
bounded by length and nothing else, so `"911"` is a legal label. References are
matched against labels and identifiers alike, and one that answers to two
different channels is refused for the same reason a repeated label is.

**A refusal that is account-wide for creates stops the remaining creates.** The
service answers one status for a spent monitor budget and an unverified account
address; either holds for every create left in the run, so the rest are skipped
with the reason rather than retried into an identical refusal apiece. Updates
of the same run are untouched, because the refusal says nothing about them.

**`cronheart init` matches by name before creating.** Its own closing advice is
to run it again, so running it again reuses the monitor rather than making a
second of one name — the state the reconciler calls unresolvable. Two of that
name already on the account is refused rather than guessed at. It also sends
channel identifiers in the order its idempotency key was derived over, since
the service fingerprints the raw bytes and one set in two orders is two bodies
under one key.

Contract 2.1.0 records two facts the SDK was relying on without stating: the
retention of a finalised idempotency reservation, which makes the anti-duplicate
guarantee a 24-hour window rather than a property of the key, and that a
monitor's status and snooze suppress delivery independently of its routing. The
README and this package's own claims are softened to what the service actually
underwrites.
