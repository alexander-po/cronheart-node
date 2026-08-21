# Releasing

Everything a release needs is wired. Nothing here fires by itself: the version
bump is a pull request a human merges, and the publish is a tag a human pushes.

The pipeline is `.github/workflows/release.yml`. It runs on a `v*` tag, calls
the CI workflow as its gate, and publishes only if that whole gate is green.
It holds no npm token — it authenticates to the registry with a short-lived
OIDC token GitHub mints for that run, which the registry accepts only from the
repository and workflow filename configured against the package.

---

## Registry-side prerequisites

These are one-time, and until they are done the release workflow cannot
publish anything — the OIDC exchange has nothing to match against.

**1. Own the name.** `cronheart` must be unclaimed or already yours on npm.
Check before anything else; if it is taken, the package name in
`package.json`, in the export map's specifiers and throughout the README all
have to change together.

**2. Enable 2FA on the npm account.** Trusted publishing does not replace it —
it removes the long-lived token, not the account's own protection.

**3. Publish once by hand, because npm requires the package to exist before a
trusted publisher can be attached to it.** This is the one publish the workflow
cannot do, and the one release with no provenance attestation. See
[The first publish](#the-first-publish) below for the exact commands.

**4. Configure the trusted publisher.** On npmjs.com, go to the package's
access settings — `https://www.npmjs.com/package/cronheart/access` — and add a
trusted publisher under **Trusted publishing**:

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

**5. Create the `npm-publish` environment on GitHub.** Repository Settings →
Environments → New environment → `npm-publish`. Add yourself as a required
reviewer if you want the publish to wait for a human click after the gate goes
green; restrict it to the `v*` tag pattern if you want the environment
unusable from a branch. Neither is required for the publish to work — the
environment only has to exist and to be named the same on both sides.

**6. Check the repository field.** npm matches `repository.url` in
`package.json` against the repository the OIDC token came from. It already
names `alexander-po/cronheart-node`; if the repository ever moves, this moves
with it.

---

## The first publish

Run the gate, build, and publish from inside the container. The container is
the supported toolchain for this repository, and a release is not the moment to
find out what a different local Node produces.

```bash
make check                       # must be green, and must be run on the commit being tagged
make build
```

Then authenticate and publish inside a throwaway container, so no credential
lands in the working tree or in the host's npm configuration:

```bash
docker compose run --rm node sh -c 'npm login && npm publish'
```

`npm login` prints a URL to open in a browser, and `npm publish` asks for the
one-time code. The container is discarded with `--rm`, and `/home/node/.npmrc`
— where the credential is written — goes with it. The working tree is
bind-mounted and is deliberately not where npm writes. The npm the image ships
is old enough to matter only for trusted publishing, which this publish does not
use; the release workflow upgrades it for itself.

If you would rather use a token than an interactive login, create a **granular
access token** on npmjs.com with write access, pass it in as an environment
variable, and revoke it the moment the publish returns:

```bash
NPM_TOKEN=<token> docker compose run --rm -e NPM_TOKEN node \
  sh -c 'npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN" --location user && npm publish'
```

`--location user` is what keeps the token out of the repository: the project
`.npmrc` would be inside the bind mount and would survive the container.

Do this once. Every release after it goes through the workflow.

**Do not push a `v0.1.0` tag.** The tag is what triggers the workflow, and
`0.1.0` is the version being published by hand here — a pushed tag would run the
gate and then fail the publish on a version the registry already has. Tag it
locally if you want the marker; `v0.1.1` is the first tag that gets pushed.

---

## Every release after the first

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
CI runs on the pull request; `main` is what gets tagged.

**3. Tag `main`.**

```bash
git checkout main && git pull
git tag v<version>
git push origin v<version>
```

The tag must name the same version as `package.json`. The workflow checks this
first and fails the release rather than publishing a tarball whose tag lies
about what is in it.

**4. Watch the run.** The `gate` job is the CI workflow — lint, the audit, the
contract check, the conformance vectors, the test suite across the Node matrix,
the ESM and CJS consumption smoke, the fault matrix and the minimum-peer run.
The `publish` job does not start until all of it passes, and then packs and
inspects the tarball once more against the tree it is about to send. If you
added required reviewers to the `npm-publish` environment, it waits for the
click there.

**5. Verify what shipped.**

```bash
npm view cronheart@<version>
npm audit signatures          # in a project that installed it
```

`npm audit signatures` is what confirms the provenance attestation is present
and links the tarball to the commit and the workflow run that built it.

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
- **The gate failed.** Nothing was published. Fix it on a branch, merge, move
  the tag.

A version already on the registry cannot be republished. If a release is wrong,
publish the next patch; `npm deprecate cronheart@<version> "<why>"` is the way
to steer people off it. Unpublishing is available only within 72 hours and only
under npm's own conditions — treat it as unavailable.
