---
'cronheart': minor
---

A time zone the service holds at one offset all year, such as `CET`, `EST` or `utc`, is refused before anything is sent, with the service's advice to use a region zone instead; `UTC` and `Z` still work. The list is exported from `cronheart/api` as `TIMEZONE_ABBREVIATIONS`, and the wire contract moves up a major version. A sync configuration naming such a zone is refused even when it matches the monitor's stored zone. `cronheart init` refuses a name that holds a monitor id. An id hidden by an invisible character or unusual separators is now cut from diagnostics, and a 503 asking for a wait beyond range is retried after the 5-second cap.
