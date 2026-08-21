# Releasing

**A release is a tag.** Nothing publishes by hand. Nothing fires by itself
either: the version bump is a pull request a human merges, and the tag is a
human pushing one at the merged commit.

The pipeline is `.github/workflows/release.yml`, and it runs on a `v*` tag in
four jobs:

| Job | What it does |
| --- | --- |
| `tag` | Asserts the tag names the version the manifest publishes. It sits ahead of the gate, so a mistyped tag costs ten seconds rather than the whole matrix. |
| `gate` | The CI workflow itself, called rather than copied: lint and the dependency audit, the contract check, the offline drift comparison, the conformance vectors, the documented-claims and leak scans, the test suite across the Node matrix, the ESM and CJS consumption smoke, the fault matrix and the minimum-peer run. |
| `ready` | The release gate — the documented claims, the leak scan and the release metadata. It is deliberately not part of CI: a branch is supposed to carry an unconsumed changeset and a release is supposed to carry none, so this is the one check only a tag can satisfy. |
| `publish` | Waits for both, builds its own `dist`, packs and inspects the tarball once more against the tree it is about to send, and publishes with provenance. |

The workflow holds no npm token. It authenticates to the registry with a
short-lived OIDC token GitHub mints for that run, which the registry accepts
only from the repository and workflow filename configured against the package.

---

## Cutting one

**1. Fold the changesets into a version.**

```bash
make version
```

This runs `changeset version` in the container: it reads `.changeset/*.md`,
bumps `package.json`, writes the entry into `CHANGELOG.md` and deletes the
changesets it consumed. Read what it wrote — a changelog assembled from
changesets is a list, and the entry a reader meets on npm should be prose.
Edit it before committing.

**2. Land it.** Commit on a `feature/` branch, open a pull request, merge it.
CI runs on the pull request; `main` is what gets tagged. Run `make release-gate`
locally before you tag — it is the one gate CI never ran on the branch, and an
unconsumed changeset is what it usually catches.

**3. Tag `main`.**

```bash
git checkout main && git pull
git tag v<version>
git push origin v<version>
```

**4. Watch the run.** Four jobs, in the order above. If you added required
reviewers to the `npm-publish` environment, `publish` waits for the click
there.

**5. Verify what shipped.**

```bash
npm view cronheart@<version>
npm audit signatures          # in a project that installed it
```

`npm audit signatures` is what confirms the provenance attestation is present
and links the tarball to the commit and the workflow run that built it.

---

## What is configured on the registry side

Standing configuration, done once and still in place. Nothing here is a step in
a release; it is the list to re-read when a publish starts failing for a reason
the tree cannot explain.

- **The package name is ours.** `cronheart`, unscoped. If it ever moves, the
  name in `package.json`, in the export map's specifiers and throughout the
  README all move together.
- **The npm account has 2FA.** Trusted publishing removes the long-lived token,
  not the account's own protection.
- **A trusted publisher is attached to the package**, under
  `https://www.npmjs.com/package/cronheart/access`:

  | Field | Value |
  | --- | --- |
  | Provider | GitHub Actions |
  | Organization or user | `alexander-po` |
  | Repository | `cronheart-node` |
  | Workflow filename | `release.yml` (the filename alone, with its extension — not a path) |
  | Environment | `npm-publish` |

  The workflow filename and the environment are matched exactly. Renaming
  `release.yml`, or removing `environment: npm-publish` from it, breaks the
  publish until the registry-side entry is edited to match.
- **The `npm-publish` environment exists on GitHub.** Repository Settings →
  Environments. It only has to exist and to be named the same on both sides;
  required reviewers and a `v*` tag restriction are optional and neither is
  configured as a precondition of the publish working.
- **`repository.url` in `package.json` names `alexander-po/cronheart-node`**,
  which is what npm matches the OIDC token's origin against.

---

## When the publish job fails

- **`ENEEDAUTH` or a 401/404 on publish.** The trusted publisher entry does not
  match the run. Check the workflow filename (`release.yml`, no path), the
  environment name on both sides, and the organization and repository fields.
- **A provenance or OIDC usage error.** Either the npm CLI in the job is older
  than 11.5.1 — the `npm install --global npm@latest` step exists for exactly
  that, so check it ran — or the job lost its `id-token: write` permission.
- **The tag check failed.** The tag and `package.json` disagree. Delete the tag,
  fix the version, tag again — do not force the publish past it.
- **`ready` failed on an unconsumed changeset.** The tree carries a change
  `CHANGELOG.md` does not describe. Fold it in with `make version`, land that,
  and move the tag.
- **The gate failed.** Nothing was published. Fix it on a branch, merge, move
  the tag.

A version already on the registry cannot be republished. If a release is wrong,
publish the next patch; `npm deprecate cronheart@<version> "<why>"` is the way
to steer people off it. Unpublishing is available only within 72 hours and only
under npm's own conditions — treat it as unavailable.

---

## Why the oldest release has no attestation

npm requires a package to exist before a trusted publisher can be attached to
it, so `0.1.0` was published by hand from a throwaway container and carries no
provenance attestation. It is the only release that does not, and no tag was
ever pushed for it. Every release since has gone through the pipeline above,
and a hand publish is no longer a path anybody should take.
