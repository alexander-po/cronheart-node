# Changesets

Every user-visible change lands with a changeset — a small markdown file
recording which packages changed, at what semver level, and the line that
belongs in the changelog.

Add one from the repo root:

```bash
make changeset
```

On release, `changeset version` folds the pending changesets into
`CHANGELOG.md` and bumps `package.json`; `changeset publish` pushes the
tag and publishes to npm.
