---
'cronheart': minor
---

CLI: `cronheart run`, `ping`, `doctor` and `init`.

`run` wraps a command and exits with that command's own exit status; a check-in
that fails writes one line to stderr and changes nothing else. Its stderr is
teed rather than captured, so a redirect in a crontab keeps working while the
last `--stderr-bytes` of it ride along with the failure check-in — cut on a
character boundary even where a character was split across two reads, over the
same truncation primitive the ping body uses. The tee honours the parent's
backpressure, so the command is paced as it would be writing to that parent
itself, and `--stderr-bytes=0` inserts no pipe at all. The command leads its
own process group: `--timeout` terminates that group and exits `124`, matching
`timeout(1)`, and `SIGINT` / `SIGTERM` reach the command once rather than once
from the group and once forwarded, escalating to `SIGKILL` after
`--kill-after`. A command that never starts exits `127` or `126`; usage errors
exit `64` before anything is spawned. The terminal check-in and its flush share
one 2 s budget, after which the status already in hand is returned and whatever
is in flight is abandoned — including when an interrupt arrives mid-check-in.

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
