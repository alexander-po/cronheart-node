---
'cronheart': minor
---

Make `cronheart sync` and `cronheart init` readable.

Under `--print-env`, stdout now carries the assignments and nothing else, so
appending the run to a `.env` leaves a file the shell can still read; the pending
list is read off the result rather than off the plan, so a run that has already
applied is no longer told to apply. A configuration the reconciler refuses is
framed as a refusal wherever it was raised, rather than as a file that could not
be read. The plan drops the unchanged rows it was burying the changed ones under
(`--all` puts them back, and a row that alerts nobody is never hidden), names
channels by the labels the file was written in, folds one schedule edit into one
row under the field name the file uses, and says the orphan note once. Declining
the deletion confirmation exits 0. `init` documents `--schedule`, says it creates
a billed monitor, splits "no channel" from "no verified channel", and takes
`--channels=none`. `Z` is accepted as a time zone; `every 5 minutes` is answered
with the forms that would have worked.
