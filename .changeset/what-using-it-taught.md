---
'cronheart': minor
---

What migrating a real consumer onto this package found.

**A failed check-in now says so by itself.** The built-in warner spoke only for the four
configuration outcomes, so a refused connection with no `onResult` produced no output at
all — a heartbeat on a timer could fail forever with nothing to show for it. Every outcome
that is not an accepted check-in and not a cancellation the caller asked for now carries a
sentence, warned once per process per cause per monitor. `describePingResult(result)`
renders any of the twelve, so replacing the warner with a logger is two lines rather than a
switch over the vocabulary.

**A value shaped like an id all the way through is diagnosed as a broken id**, not as a
name whose variable nobody set, and no variable is looked up for one: screaming a mistyped
identifier into a variable name turned a typo into a search of the environment. A value
that merely *opens* like an id — eight hexadecimal digits and a dash — is still a name,
because a monitor may legitimately be called that.

**The wrapper and the library agreed about a missing monitor.** `cronheart run --uuid=$VAR`
in a crontab whose variable went missing exited `64` without spawning the command. A
monitor this wrapper cannot use — an empty flag value, a stale id, a name behind `--uuid`,
both flags at once — is now reported on stderr and the command runs, unmonitored. `64` is
reserved for an invocation that could not be read: an unknown flag, a flag given no value,
no monitor flag at all, nothing after the `--`.

**`--action=heartbeat` is accepted**, which is what the library sends when no action is
named. The set the command line validates against is `PING_ACTIONS`, exported, so a caller
generating the flag can check the value first; `PING_EMITTABLE_ACTIONS` is the subset that
becomes a path segment.

**`--version` names the package on npm** rather than the repository it is built from. The
User-Agent keeps the language, where a server log has to tell the SDKs apart.

**Three things a consumer needed and could not reach**: `isMonitorId` for validating ids at
configuration-load time, `describePingResult` for rendering a result, and `answered` on
`PingResult` — a refused connection reports `sent: true` with no status, and telling that
from a refusal the server sent was an inference the type did not advertise.

**The command-line tool is reachable by a specifier**, `cronheart/cli`, so a container
build can resolve and copy it instead of requiring a global install. Resolve it and run it;
importing it deliberately does nothing rather than reading the host's arguments and exiting
its process. There is no programmatic entry point: the wrapper's contract is its exit
statuses and its streams.

**Every check-in is a `POST`**, with or without a body, where the verb used to follow the
body. `GET` is the one verb a cache or a scanning intermediary may answer on the server's
behalf, and a check-in answered by an intermediary is reported as accepted while the
service never saw it — the single failure a monitoring client cannot detect from its own
result. Contract 2.2.0 records the emitted verb as a client convention, so the next
language does not decide it again.
