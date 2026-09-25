---
'cronheart': minor
---

**A monitor read through `cronheart/api` now says whether it has an incident
open.** `monitor.openIncident` is `null` when none is, and otherwise
`{ kind, since }`: `kind` is the alert that opened it, `'late'` or `'fail'`,
and `since` is when that alert was raised, or `null` when the service cannot
find it. Every monitor read carries it — `get`, `list`, `iterate` and every
write that answers with a monitor. Only a successful run ends an incident, so
a monitor that was paused, resumed or snoozed can still be inside one, and no
late or fail alert is sent until it ends. The field is optional on the
`Monitor` type, so a `Monitor` written by hand for `0.1.3` still compiles;
`OpenIncident` and `IncidentKind` are exported alongside it. The wire contract
moves to 2.4.0, which states the new key.
