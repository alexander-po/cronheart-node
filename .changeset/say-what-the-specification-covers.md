---
'cronheart': patch
---

Describe the published specification's reach accurately in the wire contract.

The contract's coverage prose said the document carries no channel-secret constraint. It
publishes the secret's minimum length, and the drift watch prints that prose verbatim as its
own list of blind spots — so the one mechanism a reader trusts to say what is *not* being
watched was wrong about one item. The secret's minimum length is now compared like every
other fact (42, up from 41), and the not-covered entry is narrowed to the three channel
fields the document really does carry as prose alone.

The covers list also understated the reach by half: the schedule expression's maximum length,
the timezone and grace defaults, the channel label bounds, every read-shape key list and
nullable list, the offset minimum and the snooze required flag were all already compared and
none was mentioned. Contract 2.2.0 to 2.2.1 — editorial, so a patch.
