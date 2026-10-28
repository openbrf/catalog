# catalog

Curated plugin and theme catalog for Open BRF. Static JSON index consumed by an instance at install time.

Every instance reads an index from `main` and offers what it lists. The format is
the one index described under "Distribution and installation" in the
[plugin contract](https://github.com/openbrf/openbrf/blob/main/docs/plugin-contract.md),
read with `parseCatalogIndex` from `@openbrf/plugin-sdk`. The catalog publishes
it in three files, one for each version of the index:

| File | Index version | Read from |
| --- | --- | --- |
| [`catalog.json`](catalog.json) | 1 | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog.json` |
| [`catalog-v2.json`](catalog-v2.json) | 2 | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v2.json` |
| [`catalog-v3.json`](catalog-v3.json) | 3 | `https://raw.githubusercontent.com/openbrf/catalog/main/catalog-v3.json` |

An instance that reads version 1 keeps reading `catalog.json`. Version 2 adds
five fields to a plugin entry, `deviceRoutes`
([ADR 0031](https://github.com/openbrf/openbrf/blob/main/docs/adr/0031-a-device-token-for-a-plugin-s-own-routes.md)),
`recipients`
([ADR 0037](https://github.com/openbrf/openbrf/blob/main/docs/adr/0037-declared-outbound-hosts-and-secret-settings.md)),
`extensionPoints` and `extends`
([ADR 0030](https://github.com/openbrf/openbrf/blob/main/docs/adr/0030-plugins-that-extend-plugins.md)),
and `processing`
([ADR 0035](https://github.com/openbrf/openbrf/blob/main/docs/adr/0035-a-plugin-s-processing-and-objecting-to-it.md)),
and changes nothing else. An instance refuses a version 1 index whole when an
entry carries a field version 1 does not define, so a plugin entry that carries
any of the five, an empty list included, is not listed in `catalog.json`, and
is listed in `catalog-v2.json` and `catalog-v3.json`. (A theme's `extends`, the theme it inherits
from, is a text that version 1 defines, and is listed in both files.) Every
other entry is listed in both files, the same in both, so an instance that
reads version 2 offers what one that reads version 1 does. A pull request that
adds or changes an entry changes both files, or leaves `catalog.json` alone for
a plugin entry that carries `deviceRoutes`, `recipients`, `extensionPoints`,
`extends` or `processing`. A plugin that declares personal data states its
processing declaration, so such a plugin is not listed in `catalog.json`, and an
instance that reads version 1 does not offer it.

Version 3 adds one field to a plugin entry, `residentRoutes`
([ADR 0051](https://github.com/openbrf/openbrf/blob/main/docs/adr/0051-resident-routes-in-a-plugin-that-reads-the-register.md)),
and changes nothing else. An instance refuses a version 2 index whole when an
entry carries it, so a plugin entry that carries `residentRoutes`, an empty list
included, is listed in `catalog-v3.json` only, and `catalog-v2.json` carries
none. Every other entry of `catalog-v2.json` is listed in `catalog-v3.json`, the
same in both, so an instance that reads version 3 offers what one that reads
version 2 does. No entry carries `residentRoutes` yet, so `catalog-v3.json` is
`catalog-v2.json` with its version set to 3. A pull request that adds or changes
an entry that `catalog-v2.json` lists changes `catalog-v3.json` the same way.

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
  a run of that repository on the release's tag `v<version>`, which that
  workflow started itself rather than being called by another. An attestation
  made in any other repository, the source repository of a release-only listing
  included, is refused. The check reads every verified certificate and compares
  its claims whole, so a workflow such as `release.yml.x.yml` is refused
  whichever `gh` runs it. It also holds the repository to the numeric ids
  pinned for it in [`repositories.json`](repositories.json), so a repository
  deleted or renamed away and created again under the same name by someone
  else is refused, since GitHub gives it new ids;
- the commits that attestation names, the source it was built from, the commit
  its workflow was read at and the one its run's configuration was read at, are
  on the repository's default branch. A
  tag push runs the workflow as the tagged commit has it, so a release
  workflow's own check that the tag is on `main` can be edited away on a branch
  that is then tagged; the catalog asks GitHub instead;
- a package from a release-only repository carries a `source.json` at its root
  naming its source, a copy of the release repository's own, as below;
- the entry states the tarball's `sha512` and `bytes`, and both match the
  download and the release asset;
- the package agrees with the entry: for a plugin the package name, version,
  id, API version, permissions, personal data categories, actions, protected
  resource, recipients (each one's id, origin, purpose and categories, the
  board reading the entry's before anything is downloaded), extension points
  it offers and the ones it extends (each one's id, version and categories, as
  [below](#a-plugin-that-offers-or-extends-extension-points)), its
  processing declaration (whole, the categories of data subjects as a set: the consent screen
  shows it before anything is downloaded, and the install seeds the record of
  processing activities from it), the resident routes it declares (the board
  consents to them before anything is downloaded: the sets of paths must be
  equal, their order does not matter, and a plugin with none omits them on
  both sides; the entry's title is the curator's text and is not compared with
  the manifest's `titleKey`), whether it is an
  AI package, and the licence it reads with its release date; for a theme the
  name, version, contract and parent, the parent
  being the built-in theme or a theme in this index, and not deprecated unless
  the theme is too;
- the tarball is gzipped and holds files and directories only (no links or
  devices): at most 200 files, no file over 4 MiB and 8 MiB unpacked in all,
  and every path relative, at most 200 characters, with no `..` or empty
  segment and no backslash. The check reads a plugin with the same strict
  reader an instance reads a theme with, so a plugin outside these limits is
  not listed;
- a plugin that reads a licence names an issuer that publishes it, declares
  only keys that issuer publishes, and declares no key id that another plugin
  in this index declares with a different key (see
  [A licensed plugin](#a-licensed-plugin));
- a plugin declares no runtime dependencies and passes `pluginPackageProblems`
  from `@openbrf/plugin-sdk`; a theme passes the install lint from
  `@openbrf/theme-tools`;
- a plugin connects to nothing outside the instance that it does not declare
  in its `recipients`
  ([ADR 0037](https://github.com/openbrf/openbrf/blob/main/docs/adr/0037-declared-outbound-hosts-and-secret-settings.md)),
  and it sends personal data only through `host.recipients.fetch`, never by a
  raw `fetch`, `http` or `https` request to a declared origin. The host
  validates the request's disclosure against the recipient's declared
  categories and records it only on that route. A declaration is not a fence:
  a plugin runs with the instance's privileges, and nothing in the host stops a
  connection it did not declare or a request that skips the route. The check
  cannot see either, so the maintainer reading the server bundle holds the
  plugin to both (see below).

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
none. It reads it only after every commit the attestation names is found on
the release repository's default branch, as for any listing: a tag off that
branch runs the release workflow as that commit has it, which can omit the checks
the default branch's workflow makes, and the package copies that commit's own
`source.json`, so the byte comparison alone would accept it. It also refuses a
record:

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

### A plugin that offers or extends extension points

A plugin can offer other plugins a place to contribute to, an extension point,
and a plugin can extend a point another plugin offers
([ADR 0030](https://github.com/openbrf/openbrf/blob/main/docs/adr/0030-plugins-that-extend-plugins.md)).
Both are declared in the package's manifest, as `extensionPoints` and
`extends`, and the board reads them on the consent screens before anything is
downloaded, so the entry repeats them. A plugin that does either is not listed in
`catalog.json`.

For a plugin that offers points, `extensionPoints` lists each one with the
manifest's own fields and the curator's text:

```json
"extensionPoints": [
  {
    "id": "cards",
    "version": 1,
    "personalData": ["name"],
    "title": { "sv": "<title in Swedish>", "en": "<title in English>" },
    "description": { "sv": "<what it accepts, in Swedish>", "en": "<what it accepts, in English>" }
  }
]
```

The `title` and `description` of each point are required, in Swedish and in
English, and are the curator's rather than the plugin's own, as an entry's
`name` and `description` are: an addon's consent screen has to name the point
before the host plugin's locale files exist on the instance. The maintainers
may rewrite them, and the check does not compare them with the package. A
listing without them, or without one of the two languages, is refused by the
index schema.

For a plugin that extends points, `extends` lists each one exactly as the
manifest does, with no further field:

```json
"extends": [
  { "plugin": "<host plugin id>", "point": "cards", "version": 1, "personalData": ["name"] }
]
```

The check compares both lists with the package's, as a set: the order of the
points, and of the categories in each, does not matter, and an entry that
leaves the field out has none. It refuses the listing when the package offers
or extends a point the entry does not repeat, when the entry repeats one the
package does not declare, or when an id, a version or the categories differ.
The index schema holds the entry to the manifest's own rules (an addon declares
no points of its own, a point accepts only categories the plugin itself
handles), and, when the index lists both plugins, to the rule between an addon
and the plugin it extends: that the host offers the point, at the version the
addon names, and accepts the categories the addon hands it, and that their
permissions and the plugins joined by extensions do not put a register reader
beside a plugin that publishes to the website. A host
plugin that this index does not list is held to the same rules by the instance
when both are installed.

### A licensed plugin

A paid plugin declares the instance licence it reads in its manifest's
`licence`: one entitlement, its issuer's `name` and `url`, the issuer's public
keys by key id, and the `audiences`, the issuer's services it may present the
association's licence to
([ADR 0042](https://github.com/openbrf/openbrf/blob/main/docs/adr/0042-a-signed-licence-per-instance-verified-offline.md)).
The plugin reads only the licences its keys verify, so the catalog vouches for
those keys with the issuer's own word. The issuer publishes, at the `url` its
licensed plugins name, a document of exactly this shape:

```json
{
  "format": "openbrf-licence-issuer/1",
  "name": "<the issuer's name>",
  "keys": { "<key id>": "<base64 of the 32-byte Ed25519 public key>" },
  "repositories": ["https://github.com/<owner>/<repo>"]
}
```

`repositories` lists the repositories the issuer's plugins are released from,
each written as the artifact URL writes it. The `url` is an exact `https`
address of a named host, written as a URL prints it: no credentials, port, IP
address or `localhost`, and nothing a URL parser would rewrite. The check reads
the document at that `url` with a deadline and at most 64 KiB, without the
GitHub token, and refuses a redirect rather than following it, so the document
is the one the address answers. It refuses a listing when:

- the document cannot be read, is not that shape, or names a field twice in
  one object;
- the plugin's `licence` is not a declaration of an issuer `name` and `url`
  and a `keys` object: one that declares no key, or a key that is not text, is
  refused;
- its `name` is not, exactly, the issuer's name in the plugin's `licence`;
- it does not list the repository the listing is released from, compared
  exactly: that issuer does not publish this plugin;
- a key in the plugin's `licence.keys` is not in its `keys` under the same key
  id;
- another plugin in this index, a deprecated one included, declares one of the
  plugin's key ids with a different key. A host tries a licence against every
  installed plugin's key with the key id the licence names and refuses one that
  none of them verifies, so a board that installed one of the two would have a
  licence for the other refused.

An entry repeats the plugin's `licence` and `released`, since the board
consents to the licence before anything is downloaded. `CORE_REF` names a core
whose index schema reads them, so a licensed plugin can be listed.

## How a listing is reviewed

1. **Proposing.** Open a pull request that adds or changes one entry in
   `catalog.json`, in `catalog-v2.json` and in `catalog-v3.json` (not in
   `catalog.json` when a plugin entry carries `deviceRoutes`, `recipients`,
   `extensionPoints`, `extends` or `processing`, which need index version 2,
   and in `catalog-v3.json` only when it carries `residentRoutes`, which needs
   index version 3), and link the release it points at. A repository not yet in
   [`repositories.json`](repositories.json) is added there in the same pull
   request, with the ids GitHub gives it:
   `gh api repos/<owner>/<repo> --jq '{id: (.id | tostring), ownerId: (.owner.id | tostring)}'`.
   Confirm the repository is the one meant first: the ids are what a later
   release is held to, so they are not asked of GitHub when the check runs. The `name` and
   `description` are the curator's text, in Swedish and English; the maintainers
   may rewrite them.
2. **The check.** The `Listing checks` workflow runs on every pull request, on
   every push to `main` and every night, on `catalog.json`, `catalog-v2.json` and
   `catalog-v3.json`. It reads each index with the core's own schema, which
   refuses a version 1 index in which a plugin entry carries `deviceRoutes`,
   `recipients`, `extensionPoints`, `extends` or `processing` (a theme's `extends` is valid
   in both) and a version 2 index in which one carries `residentRoutes`, looks
   up the release, downloads the artifact, recomputes its digest and size, verifies its
   attestation and compares its certificate's claims, asks GitHub whether the
   attested commits are on the default branch, unpacks it and compares its
   manifest with the entry, checks the package's `source.json` against the
   release repository's pin, reads a licensed plugin's issuer document and holds
   the plugin's key ids to the others in the index, then runs the package check or the install lint. When
   two neighbouring versions are checked, it also holds them to each other:
   every entry that can be listed in the older version is the same in both. The pull request
   cannot merge until it passes.
   The schema and checks come from the `openbrf/openbrf` commit pinned as
   `CORE_REF` in the workflow.
3. **A person.** The check says whether a package installs, not whether it is
   safe: a plugin runs in the instance's process with its privileges. A
   maintainer named in [`CODEOWNERS`](.github/CODEOWNERS) reads the plugin's
   server bundle as packed in the listed tarball, and the declaration the board
   will be asked to consent to, checks that every place the bundle connects to
   outside the instance is one of its `recipients` and receives no more than
   that recipient declares, and that every request carrying personal data goes
   through `host.recipients.fetch` and no other way (a raw `fetch`, `http` or
   `https` call to a declared origin skips the host's disclosure validation and
   audit record, so it is refused even though the origin is declared), confirms
   that the listed repository has the tag ruleset above, and approves the pull
   request. For a licensed plugin the reviewer reads its `licence.audiences`
   as they read its `permissions`: each is a grant the board consents to, a
   service the plugin may show that the association holds the licence. Each
   one is the issuer's own service, at the host of `licence.issuer.url` or a
   subdomain of it, and one the plugin needs for what its description says.
   The reviewer confirms that the issuer's `name` is the one that holds that
   host, since the check can hold the document only to what that address
   answers. The reviewer also checks each new pin in
   [`repositories.json`](repositories.json) against
   `gh api repos/<owner>/<repo>`, and refuses a change to or removal of an
   existing pin that the pull request does not explain: a repository's id never
   changes, so a different id for a listed repository means a different
   repository. Every file in this repository is owned by the maintainers, the
   check included, so a change to the check is reviewed the same way.
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
GH_TOKEN=$(gh auth token) node check/cli.mjs   # catalog.json, catalog-v2.json and catalog-v3.json
```

Name the files to check one, or give another file of repository pins:
`node check/cli.mjs [--pins repositories.json] [index.json ...]`.

`OPENBRF_CORE` points the check at a checkout somewhere other than `.core`.
