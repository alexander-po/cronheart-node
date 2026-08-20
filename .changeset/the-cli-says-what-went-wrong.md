---
'cronheart': minor
---

The CLI says what went wrong instead of naming the outcome behind it. The ping
client has always written a sentence for the outcomes that mean something is
misconfigured, and the CLI could never reach it: reporting short-circuits on a
result sink, and every CLI command passes one. So a paused monitor — the most
silent failure state there is — printed as `paused (HTTP 410)`, and a monitor
with no id printed as `suppressed`, which reads as a deliberate act rather than
*I do not know what monitor that is*. The sentence now travels on the result as
`PingResult.message`, so the warning path, a library consumer's `onResult` and
every CLI surface all get the same words; `doctor` prints it under the check-in
line, where a silent monitor is meant to be found.

`run` now writes its summary to stderr on any non-zero outcome, and nothing at
all on success. Unwrapped, a command missing from cron's `PATH` gets you a mail
saying so; wrapped, the wrapper computed exactly that sentence and sent it only
to the server, so cron mailed nothing. A wrapper may be silent on success — it
may not be silent on failure, because failure is the entire reason cron mails.
The start-failure summary now names the command and the reason
(`backup.sh: not found on PATH (ENOENT)`).

`run` tees stdout as well as stderr into the excerpt. A job reporting its
failure on stdout — most Python, PHP and `make` output — used to produce a
check-in body of `exited with status 1` and nothing else. `--stderr-bytes` is
now `--output-bytes` to match what it bounds; the old name still works, and `0`
still inserts no pipe on either stream.

`ping` is silent on a check-in that worked, in the shape of `curl -fsS`: one
mail per run from a per-minute crontab is how a monitoring tool gets
uninstalled. Failures still go to stderr, and the confirmation is printed at a
terminal or under `--verbose`.

`--name` and `--uuid` each enforce their own shape. Both used to be one string
disambiguated by looks, so a name behind `--uuid` and an id behind `--name`
silently worked, and a mistyped id produced a redacted label and an outcome
token — the user could see neither what was tried nor what was wrong.

`doctor` says what it did **not** check — whether the monitor has a
notification channel attached and whether that channel is verified — because a
report with nothing wrong in it otherwise reads as reassurance about alerting
that nothing there established. The unconditional plan notice is gone from the
free path, and a name that resolves to nothing is now connected to the monitors
listed two lines above it.

`cronheart <command> --help` prints that command's own page, with examples.
Those examples, and the README's, now carry a crontab line that works: the id
written out rather than resolved through an environment variable cron never
loads, and absolute paths, because cron's `PATH` is not a login shell's. The
`--name` form is shown with the variable set in the crontab itself.

`init` closes with the crontab line for what it just wrote and says that an env
file is read by an application, not by cron. A destination directory that does
not exist is now a usage error naming the directory, rather than a raw `ENOENT`.

The command `run` wraps keeps its controlling terminal when there is one to
keep. Leading its own process group means `setsid`, which costs the command any
`/dev/tty` prompt — a `sudo` or `ssh` password. Run with no terminal, which is
the case a deadline and a whole-tree kill exist for, it still leads its own
group; run from a terminal it does not, and the wrapper leaves the interrupt to
the terminal that already delivered it to the whole foreground group.
