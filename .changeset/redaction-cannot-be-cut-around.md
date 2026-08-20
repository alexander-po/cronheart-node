---
'cronheart': minor
---

The CLI can no longer cut around the library's redaction. `cronheart run` used
to keep the last `--stderr-bytes` of a child's stderr by dropping bytes off the
front, and only then hand the result over to be redacted — so a secret sitting
across that cut lost the anchor every pattern keys on and was sent in full, with
nothing to show redaction had been attempted. The excerpt is now redacted before
anything cuts it, at every boundary: the write that splits a token in two, the
ring that bounds the wrapper's memory, the byte budget and the body cap. A match
running into the live end of the stream is left for the next pass rather than
matched by its prefix alone.

Redaction is now reachable from the command line: `--redact=<pattern>`
(repeatable, on `run` and `ping`) and `CRONHEART_REDACT` (one regular expression
per line) are threaded into the client, and a pattern that does not compile is a
usage error rather than a control that quietly protects nothing.
`--stderr-bytes=0` sends no excerpt at all. The built-in patterns now also cover
`Authorization: Basic`, credentials inside a URL's userinfo, and
`*_PASSWORD` / `*_TOKEN` / `*_KEY` assignments, and each keeps its anchor
visible so a redacted line stays a diagnostic.

`cronheart init` writes its env file with owner-only permissions, refuses to
write through a symbolic link, writes via a temporary file in the same directory
followed by a rename, and refuses a file it cannot read instead of replacing it
with a single line. The pasted monitor id is no longer echoed to the terminal.

A base URL carrying a credential is refused at wiring time, as is plain `http:`
to anywhere but loopback, and the message that reports it no longer repeats the
credential. `doctor` prints the base URL's origin alone. The command wrapped by
`run` is no longer given `CRONHEART_API_KEY` — check-ins need no key.
