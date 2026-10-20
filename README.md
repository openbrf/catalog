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

- its artifact is an asset of an immutable GitHub release of the listing's own
  public repository, at
  `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>.tgz`,
  the tag being `v` followed by the entry's version, and the release not a
  draft or a pre-release. That repository is the one its source lives in, or a
  release-only repository that builds it from source kept elsewhere (see
  below);
- the tarball carries a build attestation from that repository's release
  workflow, `.github/workflows/release.yml`: made on a GitHub-hosted runner, by
  a run of that repository on the release's tag `v<version>`. An attestation
  made in any other repository, the source repository of a release-only listing
  included, is refused;
- the commits that attestation names, the source it was built from and the
  commit its workflow was read at, are on the repository's default branch. A
  tag push runs the workflow as the tagged commit has it, so a release
  workflow's own check that the tag is on `main` can be edited away on a branch
  that is then tagged; the catalog asks GitHub instead;
- a package from a release-only repository carries a `source.json` at its root
  naming its source, a copy of the release repository's own, as below;
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

A listed repository should also hold its `v*` tags to a tag ruleset that lets
only its maintainers create, move or delete one. The check does not read a
repository's settings, and refuses a release built off the default branch
whatever they are; the ruleset stops anyone who can merely push from making
such a release in the first place.

### A release-only repository

A package whose source is not public is listed from a public repository that
holds its release workflow and builds the package from the private source
([ADR 0044](https://github.com/openbrf/openbrf/blob/main/docs/adr/0044-a-listing-released-from-a-repository-without-its-source.md)).
Its tarball is still a public download, and neither this check nor an instance
is given a credential for it.

The release repository pins the source it builds in a `source.json` at its own
root, and the release workflow copies that file unchanged into the package's
root, beside its `package.json` or `theme.json`:

```json
{
  "repository": "https://github.com/<owner>/<source repository>",
  "commit": "<full commit id>"
}
```

The check reads the release repository's `source.json` at the commit the
attestation names as the source, and refuses the package unless its own
`source.json` has the same bytes, or has none when the release repository pins
none. It also refuses a record:

- that is not a JSON object with exactly those two fields, each named once;
- whose `repository` is not exactly `https://github.com/<owner>/<repository>`,
  without `.git`, a trailing slash or a further path. A source on another host
  is refused, because the check can ask only GitHub whether a repository is
  public;
- whose `repository` is the release's own repository;
- whose `repository` GitHub reports public. A package whose source is public is
  released from that repository;
- whose `commit` is not 40 or 64 lowercase hexadecimal characters.

It cannot read a private source, so it does not check that the commit exists.
The record is in the tarball rather than in the release notes because an
immutable release's notes can still be edited. The attestation fixes the
record but does not prove it: the release workflow writes the package, so the
record is the author's statement of the source, pinned in the public history of
the repository that signed it.

The check reads a package without `source.json`, from a release repository that
pins none, as built from the commit its attestation names, and cannot tell a
release-only repository that left both out. The maintainer reviewing the
listing can: a release-only listing without the record is not merged. The
maintainer also checks that the release repository:

- moves its pin by a reviewed pull request for each release and pushes the tag
  on the merge, with the tag ruleset above;
- reads the pin at the tagged commit and checks out exactly that commit of the
  source, with `persist-credentials: false`;
- keeps the credential that reads the source as an **environment secret**, of
  an environment whose deployment rule allows only `v*` tags. A repository
  secret is open to every workflow and job in the repository, whatever
  environment a job names;
- uses a credential that reads the source repository and nothing else: a
  read-only deploy key, a GitHub App installation token minted in the run for
  that repository alone with `contents: read`, or a fine-grained personal
  access token limited to that repository with `contents: read`. Never a
  classic personal access token, which reaches every repository its owner can;
- builds in a job that holds the credential and has no `id-token` or
  `attestations` permission, and attests and publishes in a separate job that
  has those permissions and not the credential.

The credential is never in the package or the release, and neither the catalog
nor an instance needs one.

## How a listing is reviewed

1. **Proposing.** Open a pull request that adds or changes one entry in
   `catalog.json`, and link the release it points at. The `name` and
   `description` are the curator's text, in Swedish and English; the maintainers
   may rewrite them.
2. **The check.** The `Listing checks` workflow runs on every pull request, on
   every push to `main` and every night. It reads the index with the core's own
   schema, looks up the release, downloads the artifact, recomputes its digest
   and size, verifies its attestation and asks GitHub whether the attested
   commit is on the default branch, unpacks it and compares its manifest with
   the entry, checks the package's `source.json` against the release
   repository's pin, then runs the package check or the install lint. The pull
   request cannot merge until it passes. The schema and checks come from the
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
