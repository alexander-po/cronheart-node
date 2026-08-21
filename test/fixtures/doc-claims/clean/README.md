# A document that still describes the package

```ts
import { checkIn } from 'cronheart'

await checkIn('nightly-backup')
```

Wrap a command with `cronheart run --name=nightly-backup -- ./backup.sh`, or send
one check-in with `cronheart ping nightly-backup --action=fail`. The identifier
comes from `CRONHEART_NIGHTLY_BACKUP_UUID` and `CRONHEART_TIMEOUT_MS` bounds it.

Run the gate with `make check`.

Node's own `--env-file` and `--experimental-strip-types`, and npm's `--location`,
belong to those programs rather than to this one.
