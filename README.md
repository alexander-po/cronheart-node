# cronheart

Cron job monitoring and dead man's switch for Node.js and TypeScript —
heartbeat check-ins that alert you when a scheduled job stops running. Works
with node-cron, croner, cron, node-schedule, BullMQ, NestJS schedule, plain
crontab and systemd timers, plus a CLI wrapper for any command. Official SDK
for [cronheart.com](https://cronheart.com).

[![CI](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml/badge.svg)](https://github.com/alexander-po/cronheart-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Pre-release.** This is the repository skeleton: packaging, build, type
> surface, test harness and release pipeline. None of the runtime features are
> implemented yet, and nothing is published to npm. Every section below marked
> _Not implemented yet_ has no behaviour behind it — this README documents only
> what ships.

## Why

Uptime monitors don't catch the silent failure mode: a backup that stopped
running a month ago, an invoice job that didn't fire on the 1st, an ETL
pipeline whose timer was renamed. A per-job dead man's switch does — the job
checks in, and you hear about it when it stops.

## Install

_Not published yet._ The package name on npm is `cronheart`.

## Quick start

_Not implemented yet._ The entry point will be a one-line check-in and a
higher-order wrapper, both imported from `cronheart`.

## Schedulers

Adapters instrument the scheduler library rather than each job's call site, so
jobs added later are covered without another edit. Planned subpaths:
`cronheart/croner`, `cronheart/cron`, `cronheart/node-cron`,
`cronheart/node-schedule`, `cronheart/bullmq`, `cronheart/nestjs`.

_Not implemented yet._

## CLI

The package ships a `cronheart` binary for wrapping a command, sending a
one-off ping, and diagnosing a misconfigured setup.

_Not implemented yet — the binary currently only reports its own version._

## Not a Node project?

The CLI wraps any command, so a crontab entry, a systemd timer or a shell
script can check in without a Node codebase around it.

_Not implemented yet._

## Management API

`cronheart/api` will wrap the REST API — creating, reading and reconciling
monitors and notification channels — and `cronheart/sync` will reconcile a
declared set of monitors against the server. Both are separate entry points so
the ping path stays small in production bundles.

_Not implemented yet._

## Runtime support

Node 22 or newer. The root entry imports nothing from `node:`, which is what
keeps non-Node runtimes on the table; the CLI is the only entry point that
reaches for Node built-ins, and a test enforces the split.

## Development

Everything runs inside Docker — no Node or pnpm on the host:

```bash
make install   # pnpm install
make build     # bundle dist/ (ESM + CJS + .d.ts)
make test      # Vitest
make lint      # tsc, fixture consumer tsc, publint, attw, size budget
make check     # the full gate, including the ESM/CJS consumption smoke
make shell     # interactive shell in the container
```

`make help` lists every target. CI runs the same checks natively across a Node
version matrix.

## License

MIT — see [LICENSE](LICENSE).
