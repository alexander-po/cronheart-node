---
'cronheart': minor
---

**`cronheart signup <email> --accept-terms` makes an account from the terminal
and saves its first API key.** The service mails the address one link; the
person it belongs to opens it and types the code the command shows, and the
command writes `CRONHEART_API_KEY` to `.env` — a new file readable by its owner
alone, or a line added to an existing one. `--env-path` writes elsewhere and
`--print-env` prints the line on stdout instead. `--accept-terms` is required:
without it the command names the Terms of Service and the Privacy Policy and
stops. The command polls at the interval the service names, never faster than
once a second, waits out a 429, and stops with a plain message when the code
expires or is cancelled on the page.

The key is shown once, so the file is checked before anything is asked of the
service and again before the write: a file that already assigns the key, one
that others can read or write, a link, and a directory that cannot be written
are refused. When the file is refused at the end or the write fails, the key is
printed once on stdout, since nothing else holds it; otherwise it is printed
only under `--print-env`. The command exits 0 once the key is saved; 64 when
the invocation cannot be read, the terms were not accepted, the address is
plainly not one, or the file was refused before the flow started; and 1 when
the service refused, the code expired or was cancelled, or the key could not be
written.

`cronheart/api` gains `createSignupClient()`, whose `start({ email,
acceptTerms: true })` and `poll(deviceCode)` are the two calls that take no key.
`poll` answers `{ status: 'pending' }` or, once, `{ status: 'issued', token,
tokenPrefix, project }`, where only the token is certain: `tokenPrefix` and
`project` are `null` when the answer carries no short printable value for them,
and so is the start answer's `hint`. A signup that is no longer open rejects
with the new `ApiSignupExpiredError`, `kind: 'signup-expired'`. Neither call is
retried, a user code outside the published shape is refused rather than handed
to a terminal, and no message the client writes carries the device code or the
token. `SIGNUP_EMAIL_MAX_LENGTH` is exported with the other bounds. A 422's
message now repeats only the field names that are plain text.

The wire contract moves up a minor version: it states both routes, what each
status means on them, the three answer shapes, the user code's pattern, the
`error` member their problem documents carry, and a 410 that is a signup's own.
The drift watch reads the new facts off the published specification, and the
conformance vectors cover the signup statuses and how both answers are read.
The agent recipe and `AGENTS.md` start from `cronheart signup` rather than from
a token made in the dashboard.
