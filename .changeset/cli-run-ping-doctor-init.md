---
'cronheart': minor
---

CLI: `cronheart run`, `ping`, `doctor` and `init`.

`run` wraps a command and exits with that command's own exit status; a check-in
that fails writes one line to stderr and changes nothing else. Its stderr is
teed rather than captured, so a redirect in a crontab keeps working while the
last `--stderr-bytes` of it ride along with the failure check-in — cut on a
character boundary even where a character was split across two reads, over the
same truncation primitive the ping body uses. `--timeout` kills the command and
exits `124`, matching `timeout(1)`; `SIGINT` and `SIGTERM` are forwarded and
escalate to `SIGKILL` after `--kill-after`; a command that never starts exits
`127` or `126`; usage errors exit `64` before anything is spawned. The flush
after the terminal check-in is bounded and never changes the exit status.

`ping` sends one check-in, validating `--action` against a closed set of
literals before a URL exists, and exits `0` even on a failed check-in unless
`--strict` is asked for. `doctor` reports the resolved configuration, which
variable answered for each monitor, a real check-in and the clock skew, without
ever printing a monitor id. `init` writes `CRONHEART_<NAME>_UUID` and verifies
it; creating the monitor itself needs the REST API, so the free path links to
the dashboard and takes a pasted id.

`run` and `ping` reach nothing beyond the ping client at startup — `doctor` and
`init` are loaded on demand — and the CLI is bundled apart from the library
entries so the ping entry's size is unaffected by it.
