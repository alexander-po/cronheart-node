# Changesets

Every user-visible change lands with a changeset — a small markdown file
recording which packages changed, at what semver level, and the line that
belongs in the changelog.

Add one from the repo root:

```bash
make changeset
```

On release, `make version` runs `changeset version`, which folds the pending
changesets into `CHANGELOG.md` and bumps `package.json`. Nothing here
publishes: the release is a `v*` tag pushed at the merged bump, and the
workflow that tag starts is what talks to the registry. See
[RELEASING.md](../RELEASING.md).

A branch is supposed to carry an unconsumed changeset and a release is supposed
to carry none, which is why the release gate fails on one and CI does not.
