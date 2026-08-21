# CLAUDE.md

Project-specific notes for agents (Claude Code, Cursor, etc.) working in this
repository. The service this SDK talks to is the monitoring backend behind
cronheart.com — a separate, private repository.

## What this repo is

`cronheart` — the official Node/TypeScript SDK for
[cronheart.com](https://cronheart.com). Scheduled jobs check in over HTTP; when
one stops checking in on time, the service alerts. The package covers the ping
path, a management client for the REST API, a reconciler, a CLI, and adapters
for the common Node schedulers. It is published to npm unscoped as `cronheart`
and mirrors the shape of the sibling PHP SDK closely enough that a third
language is a port rather than a redesign.

Zero runtime dependencies. Node 22 (the oldest maintained LTS) is the floor.

## Toolchain: Docker only

There is no Node or pnpm on the host and nothing in this repo may assume
otherwise. `docker compose` owns the toolchain; the `Makefile` is the entry
point:

```bash
make install   # pnpm install
make build     # bundle dist/ (ESM + CJS + .d.ts)
make test      # Vitest
make lint      # tsc, fixture consumer tsc, source guard, publint, attw, size
make smoke     # pack the tarball, consume it from scratch ESM and CJS projects
make check     # the full gate — run this before every commit
make shell     # interactive shell in the container
make clean     # drop the containers and the node_modules / store volumes
```

Behind a TLS-inspecting proxy the container trusts no CA the host trusts, so
anything reaching the network from inside it — the live half of the drift watch,
a smoke against the real service — fails there while the same request from the
host succeeds. Hand the bundle in rather than disabling verification:

```bash
CA_FILE=/path/to/ca-bundle.pem make check
```

`node_modules`, the fixture consumer's `node_modules` and the pnpm store are
named volumes, so no platform-specific install ever lands in the working tree.
The pnpm store deliberately lives under `/app` — pointing it at another
filesystem makes pnpm relocate it into the bind mount.

CI is the exception: GitHub Actions runs the same scripts natively across a
Node version matrix, because the matrix is the thing under test. Do not
containerise the CI jobs.

## The axiom

> The ping client **never throws**. The management client **always throws**
> typed errors.

For the management half that means one base type — `CronheartApiError` — that a
transport failure, a JSON parse failure and a hydration failure all arrive as,
so a single `catch` is exhaustive; a `kind` discriminant and a `Symbol.for`
brand rather than `instanceof`, which two copies of the package break silently;
and every public method `async` (every iterator a generator), so a request this
client refuses to compose rejects rather than throwing synchronously out of
something whose signature promised a promise.

Sharpened: validation errors surface at wiring time; nothing surfaces at ping
time. A bad monitor name at boot should crash the deploy. A failed ping at 3am
must never touch the job it is monitoring.

TypeScript cannot express "this promise never rejects", so the guarantee is
mechanical rather than aspirational:

- One `safely()` chokepoint that every ping passes through, with the guarded
  region covering name resolution, URL construction and body encoding — not
  just the network call. The sibling PHP SDK left exactly those three outside
  its `try` and shipped green through its whole suite.
- A lint rule banning `await fetch`, `throw` and `Promise.reject` outside the
  transport layer, over a lexer that follows template interpolations back into
  code rather than treating everything between backticks as string content.
- An unhandled-rejection assertion across the test suite.
- A fault matrix over three axes — how the transport misbehaves, how the
  deployment is misconfigured, and what the host program hands in — with a
  deliberately-unsafe negative control, so the harness is proven able to fail.
  The host axis exists because the first two prove nothing about a throwing
  option getter, an error whose `stack` accessor throws, or an async `onResult`.

Any new callable on the published surface must enter the fault matrix in the
same change, or the matrix's ledger must record why it needs no case: the
registry is derived by reflecting over the built entry points, so a const
arrow, a default export and a class method are all visible to it.

## Packaging rules

- The root entry imports nothing from `node:`. That is what makes non-Node
  runtimes real rather than aspirational, and a test enforces it across every
  entry but the CLI.
- The management client is not at the root. The ping path ships into production
  bundles and function zips; the management path ships into CLIs. Splitting on
  the entry point makes the size guarantee structural — and the split is a
  separate `tsdown` run, not merely a separate entry in one, because a chunk
  shared with the root puts part of the ping path behind import glue every
  consumer of the check-in client then pays for. The command-line tool is split
  for the same reason, so `build` is three `tsdown` invocations in order. It is published
  under the `cronheart/cli` specifier as well as under `bin`, so a container
  build can resolve and copy it without a global install — which is why its
  dispatch sits behind an entry-point check: the file must do nothing at all
  when it is imported rather than launched. It is excluded from the
  type-resolution check, being a program rather than an API.
- The SDK version and the contract version are injected at build time — from
  `package.json` and `contract/cronheart-contract.json` — and each appears in
  exactly one place per build format. Never hardcode either in source: a test
  fails if a literal appears under `src/`. Both ride in the User-Agent, so a
  support request names the contract the client was built against.
- No `enum` anywhere, and `export type` on every type re-export:
  `verbatimModuleSyntax`, `isolatedModules` and `erasableSyntaxOnly` all reject
  the alternatives, and consumers using Node type-stripping would break.
- Options and request objects the consumer constructs use
  `readonly x?: T | undefined`, because consumers compile with
  `exactOptionalPropertyTypes`.
- Adapters declare their scheduler as an optional peer and import it with
  `import type` only. A runtime import of a peer is a bug.
- `test/fixture-consumer` compiles a sample import against the exports map
  under the consumer's strict flags. New subpaths go in there too.

## Branch & commit conventions

- **Never commit directly to `main`.** Every change lives on its own feature
  branch and lands via a merged pull request. No exceptions for "small" or
  "docs-only".
- **Branch naming**: `feature/<short-kebab-topic>`, describing what was done
  rather than the area touched.
- **One commit per branch.** Squash review / fixup / wip commits before opening
  the PR: `git reset --soft origin/main && git commit`.
- Local `main` must always equal `origin/main`.
- **No AI co-author trailers** in commit messages.
- Claude commits and hands over the push command; the human pushes and opens
  the PR.
- The git identity is set repo-locally to the GitHub noreply address. Check it
  with `git config --local --get user.email` before the first commit —
  `git commit --amend` preserves the original author, so a late fix flips the
  committer while the author stays wrong.

## Public-repo hygiene

This repository is public; the backend is private. Nothing that identifies
backend internals may be written here — no backend class or file names, no
internal issue or PR references, no machine-local absolute paths, no real
addresses, no live monitor ids, nothing token-shaped. Describe the concept
instead: "the server's ping ingest" rather than a class name.

Session working notes stay local — `HANDOFF.md` is git-ignored. `CLAUDE.md` is
committed but excluded from the published tarball via the `files` allow-list.

## Comments

Default to none. If a line needs a comment, rename the thing or extract a named
helper until it reads on its own. The exception is a genuinely non-obvious
constraint whose violation a reader would not notice — a wire-format rule, an
ordering requirement, a workaround for a documented runtime behaviour. State
what is true and what would break, never how it was found; measurements,
before/after numbers and incident narratives belong in the commit message.
