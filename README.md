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
- the tarball carries a build attestation from that repository;
- the entry states the tarball's `sha512` and `bytes`, and both match;
- the package agrees with the entry: for a plugin the package name, version,
  id, API version, permissions, personal data categories, actions and protected
  resource; for a theme the name, version, contract and parent, the parent
  being the built-in theme or a theme in this index;
- a plugin declares no runtime dependencies and passes `pluginPackageProblems`
  from `@openbrf/plugin-sdk`; a theme passes the install lint from
  `@openbrf/theme-tools`.

## How a listing is reviewed

1. **Proposing.** Open a pull request that adds or changes one entry in
   `catalog.json`, and link the release it points at. The `name` and
   `description` are the curator's text, in Swedish and English; the maintainers
   may rewrite them.
2. **The check.** The `Listing checks` workflow runs on every pull request, on
   every push to `main` and every night. It reads the index with the core's own
   schema, looks up the release, downloads the artifact, recomputes its digest
   and size, verifies its attestation, unpacks it and compares its manifest with
   the entry, then runs the package check or the install lint. The pull request
   cannot merge until it passes. The schema and checks come from the
   `openbrf/openbrf` commit pinned as `CORE_REF` in the workflow.
3. **A person.** The check says whether a package installs, not whether it is
   safe: a plugin runs in the instance's process with its privileges. A
   maintainer named in [`CODEOWNERS`](.github/CODEOWNERS) reads the plugin's
   server bundle as packed in the listed tarball, and the declaration the board
   will be asked to consent to, and approves the pull request. Every file in
   this repository is owned by the maintainers, the check included, so a change
   to the check is reviewed the same way.
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
