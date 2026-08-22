---
'cronheart': patch
---

**The ping entry's stated ceiling is now 8 KiB rather than 7 KiB.** Nothing
grew to meet it: the entry measures well under either number, and every build
prints what it measures. What changed is the bound this package promises not to
cross, which had three bytes left after the response cap and the corrections
that followed it — a ceiling that tight decides the next correctness fix by
arithmetic rather than on its merits.

The check-in path is still bundled apart from the management client and the
command-line tool, so what a consumer of `cronheart` downloads is still only the
check-in path, and the size check still fails the build on a regression past the
bound.
