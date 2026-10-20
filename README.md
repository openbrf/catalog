# catalog

Curated plugin and theme catalog for Open BRF. Static JSON index consumed by an instance at install time.

Every instance reads [`catalog.json`](catalog.json) from `main` at
`https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json` and offers
what it lists. The format is the one index described under "Distribution and
installation" in the
[plugin contract](https://github.com/openbrf/openbrf/blob/main/docs/plugin-contract.md),
read with `parseCatalogIndex` from `@openbrf/plugin-sdk`.

## What a listing must meet

A package is listed when:

- its artifact is an asset of an immutable GitHub release of the repository its
  source lives in, at
  `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>.tgz`,
  the tag being `v` followed by the entry's version, and the release not a
  draft or a pre-release;
- the tarball carries a build attestation from that repository's release
  workflow, `.github/workflows/release.yml`: made on a GitHub-hosted runner, by
  a run of that repository on the release's tag `v<version>`, which that
  workflow started itself rather than being called by another. The check reads
  every verified certificate and compares its claims whole, so a workflow such
  as `release.yml.x.yml` is refused whichever `gh` runs it. It also holds the
  repository to the numeric ids pinned for it in
  [`repositories.json`](repositories.json), so a repository deleted or renamed
  away and created again under the same name by someone else is refused, since
  GitHub gives it new ids;
- the commits that attestation names, the source it was built from, the commit
  its workflow was read at and the one its run's configuration was read at, are
  on the repository's default branch. A
  tag push runs the workflow as the tagged commit has it, so a release
  workflow's own check that the tag is on `main` can be edited away on a branch
  that is then tagged; the catalog asks GitHub instead;
- the entry states the tarball's `sha512` and `bytes`, and both match the
  download and the release asset;
- the package agrees with the entry: for a plugin the package name, version,
  id, API version, permissions, personal data categories, actions and protected
  resource; for a theme the name, version, contract and parent, the parent
  being the built-in theme or a theme in this index, and not deprecated unless
  the theme is too;
- the tarball is gzipped and holds files and directories only (no links or
  devices): at most 200 files, no file over 4 MiB and 8 MiB unpacked in all,
  and every path relative, at most 200 characters, with no `..` or empty
  segment and no backslash. The check reads a plugin with the same strict
  reader an instance reads a theme with, so a plugin outside these limits is
  not listed;
- a plugin declares no runtime dependencies and passes `pluginPackageProblems`
  from `@openbrf/plugin-sdk`; a theme passes the install lint from
  `@openbrf/theme-tools`.

The check does not read a listed repository's settings. It proves that the
commit a release was built from is an ancestor of the default branch, so that a
release is not built off a branch. That means the commit was merged, not that
anyone reviewed it. A listed repository should have:

- a tag ruleset on `refs/tags/v*` restricting creation, update and deletion,
  which only the Admin role bypasses, so that anyone who can merely push
  cannot make a release at all. A maintainer confirms this one when reviewing a
  listing.

A listed repository is also recommended, not required, to have a ruleset on its
default branch that requires a pull request with at least one approving review,
and approval of the most recent push by someone other than the person who
pushed it, so that a change to the release workflow reaches the default branch
only after a second person has read it. Requiring a code owner's review, with
`.github/workflows/` in `CODEOWNERS`, narrows that reader to the people trusted
with releases. Neither the check nor the reviewer holds a listing to this rule.

## How a listing is reviewed

1. **Proposing.** Open a pull request that adds or changes one entry in
   `catalog.json`, and link the release it points at. A repository not yet in
   [`repositories.json`](repositories.json) is added there in the same pull
   request, with the ids GitHub gives it:
   `gh api repos/<owner>/<repo> --jq '{id: (.id | tostring), ownerId: (.owner.id | tostring)}'`.
   Confirm the repository is the one meant first: the ids are what a later
   release is held to, so they are not asked of GitHub when the check runs. The `name` and
   `description` are the curator's text, in Swedish and English; the maintainers
   may rewrite them.
2. **The check.** The `Listing checks` workflow runs on every pull request, on
   every push to `main` and every night. It reads the index with the core's own
   schema, looks up the release, downloads the artifact, recomputes its digest
   and size, verifies its attestation and compares its certificate's claims,
   asks GitHub whether the attested commits are on the default branch, unpacks
   it and compares its manifest with the entry, then runs the package check or
   the install lint. The pull request cannot merge until it passes. The schema
   and checks come from the `openbrf/openbrf` commit pinned as `CORE_REF` in the
   workflow.
3. **A person.** The check says whether a package installs, not whether it is
   safe: a plugin runs in the instance's process with its privileges. A
   maintainer named in [`CODEOWNERS`](.github/CODEOWNERS) reads the plugin's
   server bundle as packed in the listed tarball, and the declaration the board
   will be asked to consent to, confirms that the listed repository has the tag
   ruleset above, and approves the pull request. Every file in this repository
   is owned by the maintainers, the check included, so a change to the check is
   reviewed the same way.
4. **Delisting.** A pull request that removes the entry, or sets
   `"deprecated": true` to keep existing installs while offering it to no new
   one. A nightly failure on a listed entry is fixed or delisted the same way.

Report a problem with a listed package privately, as described in
[SECURITY.md](https://github.com/openbrf/openbrf/blob/main/SECURITY.md).

## Running the check locally

The check needs Node and a checkout of `openbrf/openbrf` at `CORE_REF` with its
plugin SDK and theme tools built:

```sh
git clone https://github.com/openbrf/openbrf .core
git -C .core checkout <CORE_REF from .github/workflows/check.yml>
(cd .core && pnpm install --frozen-lockfile --filter "@openbrf/plugin-sdk..." --filter "@openbrf/theme-tools..." \
  && pnpm --filter "@openbrf/plugin-sdk..." --filter "@openbrf/theme-tools..." build)

node --test check/                  # the checks' own tests, offline
GH_TOKEN=$(gh auth token) node check/cli.mjs catalog.json
```

`OPENBRF_CORE` points the check at a checkout somewhere other than `.core`.
