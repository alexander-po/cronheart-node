---
'cronheart': minor
---

The client now drops identifier-shaped text from the service's answers on routes that send no id. On `api.monitors.list`, `api.monitors.iterate`, `api.monitors.create` and `api.account.get`, a `title`, `detail` or `upgradeUrl` on `error.problem` whose text holds a monitor id in ASCII hex digits, hyphenated 8-4-4-4-12 wherever it stands or a bare run of exactly 32 with no hex digit next to it, is dropped whole, and so is an entry of `error.errors` whose key or message holds one; the rest of the answer is kept as the service wrote it. An id spelled any other way is not recognised. The wire contract states the rule for ports alongside the routes that already withhold the service's wording.
