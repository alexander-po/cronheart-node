# A document that has drifted away from the package

```ts
import { checkIn } from 'cronheart'

await checkIn('nightly-backup', { actoin: 'success' })
```

Wrap a command with `cronheart run --name=nightly-backup --quietly -- ./backup.sh`,
or reconcile with `cronheart reconcile --config=cronheart.config.ts`. The
identifier comes from `CRONHEART_MONITOR_TOKEN`.

Run the gate with `make audit-everything`.

Node's own `--env-file` and `--experimental-strip-types`, and npm's `--location`,
belong to those programs rather than to this one.
