---
'cronheart': minor
---

A check-in the service answered 503 is retried after the `Retry-After` it stated, at most 5 seconds per wait, still inside the one timeout budget and the three attempts the client makes by default; a caller's abort ends the wait at once. Other 5xx answers and connection errors keep the short wait, and a 4xx is never retried. A name that carries a monitor id anywhere in it is printed with the id cut in the label, and the variable a diagnostic names shows `<ID>` where the id sits; an id written with a non-breaking hyphen or an en dash is recognised as one everywhere an id is recognised, service problem text and sync labels included. `init` prints the name it created or found through the same set as the rest of its output. `sync --print-env` takes each variable name from the configured name rather than the service's echo of it.
