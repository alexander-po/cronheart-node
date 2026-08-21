# Security policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/alexander-po/cronheart-node/security/advisories/new>**

Please do not open a public issue, a pull request or a discussion for a
suspected vulnerability — a public report is a disclosure.

Include what you have: the version, the entry point (`cronheart`,
`cronheart/api`, `cronheart/sync`, an adapter, the CLI), what an attacker
obtains, and the smallest reproduction you can manage. A reproduction against a
throwaway monitor is worth more than a description; if you need one, a Free
account creates one in a minute.

This is a small project with one maintainer. Expect an acknowledgement within
three working days and an assessment within fourteen. If you have heard nothing
after a week, assume the notification was lost rather than ignored and ping the
advisory thread.

If the issue is in the cronheart.com service rather than in this package, say so
in the report and it will be routed rather than fixed here.

## Supported versions

While the package is on `0.x`, fixes land on the newest published minor and
nowhere else — there are no backports to an earlier `0.x` line. Once `1.0.0`
ships, the current major receives security fixes for as long as it is current.

The Node versions a given release supports are stated in the README under
[Versioning, public API and Node support](README.md#versioning-public-api-and-node-support).
A Node release that has reached end of life is not supported, and dropping one
is a minor bump while the package is on `0.x`.

## What this package treats as a security property

These are the properties a report can be filed against. Each is enforced in
code and covered by the test suite; if you can break one, that is a
vulnerability rather than a bug.

- **A monitor id is a credential.** It is the whole capability on the check-in
  route: anyone holding it can mark the monitor up. It never reaches a log line,
  a warning, an error message, an exception property or the `sync` plan table;
  where a monitor has to be named in one of those, it is named by its label, and
  an id given where a label belongs is cut to its last four characters.
  `cronheart doctor` reports which environment variable answered for a monitor
  and never the value.
- **An API key travels in the `Authorization` header and nowhere else.** Never a
  query string, never a redirect target. It appears in no message, no `toJSON`,
  no error `cause`, and this package refuses to send it over plain `http` to
  anything but loopback — an exact `localhost`, an IPv6 loopback literal or a
  real `127.x.x.x` address, matched anchored, so a host anyone can register
  cannot pass as loopback.
- **A job's output is redacted before it is cut.** The CLI's excerpt is
  redacted first and truncated afterwards, at every boundary, so truncation can
  only ever split a `[redacted]` marker rather than strip the anchor off a
  secret and leave the secret behind. Redaction reaches back 2 KiB of the stream
  at each boundary; a single secret longer than that is stated as not covered.
- **A check-in never throws.** A monitoring library that breaks the job it
  monitors is the failure mode this package exists to avoid. Anything that
  escapes the ping path into the calling program is a defect of the same
  severity as a leak.
- **A redirect is never followed.** Following one would convert a `POST` into a
  `GET`, drop the body, and send a check-in to a host the configuration never
  named.
- **Zero runtime dependencies.** The published package requires nothing at
  install time; every scheduler is an optional peer imported for its types only.
  There is no install script and no postinstall hook.

## What is out of scope

- The behaviour of a scheduler, queue or framework this package adapts, unless
  the adapter is what makes it exploitable.
- A monitor id or API key that a consumer's own code puts into its own logs.
- Denial of service achieved by configuring this package against a host you
  control — the base URL is yours to set.
- Reports produced solely by a scanner against a version's dependency tree.
  There is no runtime dependency tree, so a development-only advisory is a
  maintenance issue rather than a vulnerability in what you install — the
  release gate still refuses to publish over a high-severity one, because those
  are the tools that produce the tarball.

## Verifying what you installed

Releases published through the repository's release workflow carry an npm
provenance attestation linking the tarball to the commit and the workflow run
that built it:

```bash
npm audit signatures
```

The one exception is the first publish of the package name, which npm requires
to happen before a trusted publisher can be configured for it, and which
therefore has no attestation. Everything after it does.
