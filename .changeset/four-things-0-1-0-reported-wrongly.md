---
'cronheart': patch
---

Four corrections to `0.1.0`. Each is something it reported wrongly rather than
something it could not do, so upgrading changes no API, no configuration and no
wire behaviour.

- **A check-in whose budget runs out while a server error is being read now
  reports `server-error` rather than `timeout`.** `0.1.0` already did this when
  the error had come from an earlier attempt, but threw the answer away when the
  response arrived and the budget ran out inside the same attempt — so a caller
  watching for *the service is erroring* was told *we could not reach it*, and
  the status went missing along with it. If you branch on `result.outcome`, this
  is the one behavioural change in the release. A stalled `2xx` still reports the
  deadline, because the body is what tells an accepted check-in from a duplicate
  one and an unread one would be a guess.
- **A command that does not exist now exits `64` instead of `0`.** `cronheart
  nosuchcommand --help` printed the general help and reported success, so a typo
  in a crontab looked like it had worked. Every other usage error already exited
  `64`. `--help` and `--version` after a command that does exist are unchanged.
- **`--version`, `-V` and `-h` are documented.** All three worked in `0.1.0` and
  appeared on no help page. `cronheart --help` now names them, and the README
  shows `cronheart --version`. No flag changed; there was simply no way to find
  out these existed.
- **The check-in body now says when the wrapper escalated to `SIGKILL`.**
  `cronheart run --kill-after` sent that signal without recording that it had, so
  an alert could not tell a job something else killed from one the wrapper
  killed. The forwarded-signal path already said what it had done; now both do —
  `(cronheart forwarded SIGTERM, then escalated to SIGKILL)` — and so does the
  `--timeout` path, whose summary named no signal at all.
