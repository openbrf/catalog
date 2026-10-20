import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The checks every listing in the curated index passes before it is merged.
 *
 * The rules are the ones the plugin contract states under "What a listing must
 * meet" (docs/plugin-contract.md in openbrf/openbrf). Every instance reads
 * `catalog.json` from `main` and offers what it lists, so this is the one place
 * those rules are enforced for the curated catalog.
 *
 * Nothing here reaches the network or the core by itself. The caller hands in
 * the core's own packages and the four things that do reach out - reading a
 * release, downloading an artifact, verifying an attestation, asking whether a
 * commit is on the default branch - so the rules are tested offline against
 * fixtures and run for real in CI.
 */

/**
 * The most bytes read for one artifact.
 *
 * Above what any plugin or theme needs, and a bound on what a listing can make
 * the check download.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** A path segment of a release URL: no percent-encoding, no dot segments. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * The workflow, in the package's own repository, whose attestation a listing
 * carries. One path for every listing, so a workflow added on a branch under
 * another name signs nothing the catalog accepts.
 */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

/** The OIDC issuer GitHub Actions on github.com signs with. */
const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const HEX_PATTERN = /^[0-9a-f]{128}$/i;
/** A full commit id: SHA-1, or SHA-256 in a repository that uses it. */
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * @typedef {object} ListingDeps
 * @property {typeof import("@openbrf/plugin-sdk")} sdk
 * @property {typeof import("@openbrf/theme-tools")} themeTools
 * @property {(owner: string, repo: string, tag: string) => Promise<Release | null>} releaseOf
 *   The release published under a tag, or null when there is none.
 * @property {(url: string, maxBytes: number) => Promise<Uint8Array>} fetchArtifact
 * @property {(bytes: Uint8Array, fileName: string, repository: string, tag: string, workflow: string) => Promise<Attestation>} verifyAttestation
 *   Whether the bytes carry a build attestation signed by the workflow at that
 *   path in the repository, in a run on the tag.
 * @property {(owner: string, repo: string, commit: string) => Promise<DefaultBranch>} defaultBranchHas
 *   Whether a commit is the head of the repository's default branch or an
 *   ancestor of it.
 * @property {Record<string, RepositoryPin>} repositoryPins
 *   The GitHub ids of each repository a listing may come from, by
 *   `<owner>/<repo>` as the artifact URL writes it: `repositories.json`.
 *
 * @typedef {object} RepositoryPin
 * @property {string} id
 *   The repository's numeric id, as the certificate's
 *   `sourceRepositoryIdentifier`.
 * @property {string} ownerId
 *   The owner's numeric id, as `sourceRepositoryOwnerIdentifier`.
 *
 * @typedef {{ ok: true, certificates: unknown[] } | { ok: false, reason: string }} Attestation
 *   When it verifies, the signing certificate of each attestation that did, as
 *   `gh attestation verify --format json` reports it: an object of the claims
 *   GitHub's OIDC token stated for the run, such as `buildSignerURI` and
 *   `sourceRepositoryDigest`.
 *
 * @typedef {object} DefaultBranch
 * @property {string} branch
 * @property {boolean} has
 *
 * @typedef {object} Release
 * @property {boolean} draft
 * @property {boolean} prerelease
 * @property {boolean} immutable
 * @property {{ name: string, size: number }[]} assets
 */

const GITHUB_ID = /^[1-9][0-9]*$/;

/** A GitHub id as the certificate states it: a string of decimal digits. */
const isGithubId = (value) => typeof value === "string" && GITHUB_ID.test(value);

/**
 * The repositories a listing may come from, read from `repositories.json`:
 * each `<owner>/<repo>` as an artifact URL writes it, with the numeric ids
 * GitHub gave the repository and its owner. The ids are written by a person,
 * after confirming the repository is the one meant, in a change a maintainer
 * reviews; they are not asked of GitHub when the check runs, since after a
 * takeover GitHub names the new holder's.
 *
 * @param {unknown} input
 * @returns {{ ok: true, pins: Record<string, RepositoryPin> } | { ok: false, issues: string[] }}
 */
export function parseRepositoryPins(input) {
  const isObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(input) || input.version !== 1 || !isObject(input.repositories)) {
    return {
      ok: false,
      issues: ['expected {"version": 1, "repositories": {...}}.'],
    };
  }

  const issues = [];
  const pins = {};
  for (const [name, pin] of Object.entries(input.repositories)) {
    const [owner, repo, ...rest] = name.split("/");
    if (
      rest.length > 0 ||
      ![owner, repo].every((segment) => SEGMENT.test(segment ?? ""))
    ) {
      issues.push(`${JSON.stringify(name)} is not "<owner>/<repo>".`);
      continue;
    }
    if (
      !isObject(pin) ||
      Object.keys(pin).sort().join() !== "id,ownerId" ||
      !isGithubId(pin.id) ||
      !isGithubId(pin.ownerId)
    ) {
      issues.push(
        `${name} states {"id", "ownerId"}, each the decimal digits GitHub gives as a string.`,
      );
      continue;
    }
    pins[name] = { id: pin.id, ownerId: pin.ownerId };
  }
  return issues.length === 0 ? { ok: true, pins } : { ok: false, issues };
}

/**
 * Checks a parsed `catalog.json`.
 *
 * Returns every problem found, each prefixed with the entry it concerns. An
 * index the schema refuses is reported as such and nothing further is checked,
 * because an instance refuses that index whole.
 *
 * @param {unknown} input
 * @param {ListingDeps} deps
 * @returns {Promise<string[]>}
 */
export async function catalogProblems(input, deps) {
  const parsed = deps.sdk.parseCatalogIndex(input);
  if (!parsed.ok) {
    return parsed.issues.map((issue) => `catalog.json: ${issue}`);
  }

  const { entries } = parsed.value;
  const problems = [];
  /** Theme packages read from verified bytes, by id, for the lint below. */
  const themes = new Map();

  for (const entry of entries) {
    const label = `${entry.type} ${entry.id} ${entry.version}`;
    const found = await entryProblems(entry, deps, themes);
    problems.push(...found.map((problem) => `${label}: ${problem}`));
  }

  // Linted once every theme has been read, so a theme extending another in the
  // index is measured with its parent's values in place, as on an instance
  // that installed both.
  const themeEntries = new Map(
    entries
      .filter((entry) => entry.type === "theme")
      .map((entry) => [entry.id, entry]),
  );
  for (const entry of entries) {
    if (entry.type !== "theme") {
      continue;
    }
    const label = `${entry.type} ${entry.id} ${entry.version}`;
    const { ancestors, unlisted } = ancestry(
      entry,
      themeEntries,
      deps.themeTools.BUILT_IN_THEME_ID,
    );
    if (unlisted !== undefined && ancestors.length === 0) {
      // Nothing to lint against: the lint would only report the same parent
      // missing again.
      problems.push(
        `${label}: extends ${unlisted}, which is neither the built-in theme nor a theme in this index.`,
      );
      continue;
    }

    // Catalog policy: a deprecated entry is kept for the instances that have
    // it and offered to no new one, so a theme still offered extends none.
    const deprecated = ancestors.find((ancestor) => ancestor.deprecated === true);
    if (deprecated !== undefined && entry.deprecated !== true) {
      problems.push(
        `${label}: extends ${through(ancestors, deprecated)}, which is deprecated in this index, so a new install cannot install ${deprecated.id}.`,
      );
    }

    const pkg = themes.get(entry.id);
    if (pkg === undefined) {
      continue;
    }
    // The last ancestor fails when its own parent is not listed.
    const failed =
      ancestors.find((ancestor) => !themes.has(ancestor.id)) ??
      (unlisted === undefined ? undefined : ancestors.at(-1));
    if (failed !== undefined) {
      // Linted without that ancestor, the theme would be refused for the
      // ancestor's fault; the ancestor's own problems are reported above.
      problems.push(
        `${label}: extends ${through(ancestors, failed)}, which failed its checks, so it is not linted until ${failed.id} passes.`,
      );
      continue;
    }
    const others = [...themes.values()]
      .filter((other) => other !== pkg)
      .map((other) => deps.themeTools.chainEntryFor(other.manifest));
    const lint = deps.themeTools.lintThemeAgainst(pkg, others);
    if (!lint.ok) {
      for (const finding of lint.findings) {
        if (finding.severity === "error") {
          problems.push(
            `${label}: the install lint refuses it (${finding.rule} ${JSON.stringify(finding.detail)}).`,
          );
        }
      }
    }
  }

  return problems;
}

/**
 * The themes in the index a theme extends, its parent first, up to the
 * built-in theme or a theme already on the chain. `unlisted` is the id the
 * chain stops at when that is neither the built-in theme nor in the index.
 */
function ancestry(entry, themeEntries, builtInId) {
  const ancestors = [];
  const seen = new Set([entry.id]);
  let parent = entry.extends;
  while (parent !== undefined && parent !== builtInId && !seen.has(parent)) {
    const listed = themeEntries.get(parent);
    if (listed === undefined) {
      return { ancestors, unlisted: parent };
    }
    ancestors.push(listed);
    seen.add(parent);
    parent = listed.extends;
  }
  return { ancestors, unlisted: undefined };
}

/** "B, which extends A": the chain from a theme's parent up to `ancestor`. */
function through(ancestors, ancestor) {
  return ancestors
    .slice(0, ancestors.indexOf(ancestor) + 1)
    .map((listed) => listed.id)
    .join(", which extends ");
}

/**
 * The problems with one entry, stopping at the first check whose failure makes
 * the later ones meaningless: nothing is unpacked from bytes whose digest has
 * not been verified.
 */
async function entryProblems(entry, deps, themes) {
  const { artifact } = entry;

  const location = releaseLocation(artifact.url, entry.version);
  if (typeof location === "string") {
    return [location];
  }

  if (artifact.bytes === undefined) {
    return ["the artifact states no size; a curated listing states `bytes`."];
  }

  let expectedDigest;
  try {
    expectedDigest = parseSha512(artifact.sha512);
  } catch (error) {
    return [error.message];
  }

  let release;
  try {
    release = await deps.releaseOf(location.owner, location.repo, location.tag);
  } catch (error) {
    return [`the release could not be read: ${error.message}`];
  }
  const releaseProblem = releaseProblems(release, location, artifact.bytes);
  if (releaseProblem !== null) {
    return [releaseProblem];
  }

  let bytes;
  try {
    bytes = await deps.fetchArtifact(artifact.url, MAX_ARTIFACT_BYTES);
  } catch (error) {
    return [`the artifact could not be downloaded: ${error.message}`];
  }

  const problems = [];
  if (bytes.byteLength !== artifact.bytes) {
    problems.push(
      `the entry states ${String(artifact.bytes)} bytes, the artifact is ${String(bytes.byteLength)}.`,
    );
  }
  const actualDigest = createHash("sha512").update(bytes).digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    problems.push(
      `the entry states ${formatSha512(expectedDigest)}, the artifact is ${formatSha512(actualDigest)}.`,
    );
  }
  if (problems.length > 0) {
    return problems;
  }

  const attestation = await deps.verifyAttestation(
    bytes,
    location.file,
    `${location.owner}/${location.repo}`,
    location.tag,
    RELEASE_WORKFLOW,
  );
  if (!attestation.ok) {
    // gh names the claim that failed only for some; a wrong workflow it reports
    // as a failure to verify, so the message says what was asked for.
    return [
      `the artifact's build attestation does not verify as made by ${RELEASE_WORKFLOW} of ${location.owner}/${location.repo} in a run on ${location.tag}, on a GitHub-hosted runner: ${attestation.reason}`,
    ];
  }

  const pin = deps.repositoryPins[`${location.owner}/${location.repo}`];
  if (pin === undefined) {
    return [
      `${location.owner}/${location.repo} is not in repositories.json, so the attestation's repository ids cannot be held to anything. After confirming the repository is the one meant, add its ids from \`gh api repos/${location.owner}/${location.repo} --jq '{id: (.id | tostring), ownerId: (.owner.id | tostring)}'\`.`,
    ];
  }

  const signer = signerProblems(attestation.certificates, location, pin);
  if (signer.length > 0) {
    return signer;
  }

  const provenance = await provenanceProblems(
    attestation.certificates.flatMap((certificate) => [
      certificate.sourceRepositoryDigest,
      certificate.buildSignerDigest,
      certificate.buildConfigDigest,
    ]),
    location,
    deps,
  );
  if (provenance.length > 0) {
    return provenance;
  }

  return entry.type === "plugin"
    ? pluginProblems(entry, bytes, deps)
    : themeProblems(entry, bytes, deps, themes);
}

/**
 * The claims every attestation's certificate states, each the whole string.
 *
 * `gh attestation verify` is asked for the same, but how it matches its flags
 * is the installed gh's: before v2.102.0 `--signer-workflow` matched a prefix,
 * so a pin on `release.yml` also accepted `release.yml.x.yml`. Comparing the
 * claims here holds every gh to the same rule. The workflow that started the
 * run (`buildConfigURI`) is the signer itself, so another workflow calling
 * `release.yml` as a reusable one signs nothing the catalog accepts.
 *
 * The repository is also held to the ids pinned for it. A name says nothing of
 * who holds it: a repository deleted or renamed away can be created again
 * under the same name by someone else, whose runs state the same
 * `sourceRepositoryURI`, but the ids GitHub gave the original ones.
 */
export function expectedClaims({ owner, repo, tag }, pin) {
  const repository = `https://github.com/${owner}/${repo}`;
  const workflow = `${repository}/${RELEASE_WORKFLOW}@refs/tags/${tag}`;
  return {
    issuer: ACTIONS_ISSUER,
    sourceRepositoryURI: repository,
    sourceRepositoryIdentifier: pin.id,
    sourceRepositoryOwnerIdentifier: pin.ownerId,
    sourceRepositoryRef: `refs/tags/${tag}`,
    buildSignerURI: workflow,
    buildConfigURI: workflow,
    runnerEnvironment: "github-hosted",
  };
}

/**
 * Why the verified certificates do not name the release workflow of the
 * release's repository in a run on its tag, or nothing. Every certificate is
 * held to every claim, so one stray attestation is enough to refuse.
 */
function signerProblems(certificates, location, pin) {
  if (certificates.length === 0) {
    return ["gh attestation verify reported no attestation that verified."];
  }
  const expected = expectedClaims(location, pin);
  const problems = new Set();
  for (const certificate of certificates) {
    if (certificate === null || typeof certificate !== "object") {
      problems.add(
        "the artifact's build attestation has no certificate the check can read.",
      );
      continue;
    }
    for (const [claim, value] of Object.entries(expected)) {
      if (certificate[claim] !== value) {
        problems.add(
          `the artifact's build attestation states ${claim} ${String(JSON.stringify(certificate[claim]))}, not ${JSON.stringify(value)}.`,
        );
      }
    }
  }
  return [...problems];
}

/**
 * Why the attested commits do not tie the artifact to the default branch, or
 * nothing.
 *
 * A tag push runs the release workflow as it is at the tagged commit, so a
 * workflow that checks its own commit is on `main` can be edited on a branch,
 * tagged there and still sign. The catalog asks GitHub instead: every commit
 * an attestation names, the source, the one the workflow was read at and the
 * one the run's configuration was read at, has
 * to be on the repository's default branch, the branch head or an ancestor of
 * it. That proves the commit reached the branch, not that anyone reviewed it:
 * whether a merge needs an approving review is the listed repository's branch
 * rule, which the check does not read, so the person reviewing a listing
 * confirms it.
 */
async function provenanceProblems(commits, location, deps) {
  const unique = [...new Set(commits)];
  // An index, not the value: a certificate without the claim gives undefined.
  const malformed = unique.findIndex(
    (commit) => typeof commit !== "string" || !COMMIT_PATTERN.test(commit),
  );
  if (malformed !== -1) {
    return [
      `the artifact's build attestation names ${String(JSON.stringify(unique[malformed]))}, which is not a commit id.`,
    ];
  }

  const problems = [];
  for (const commit of unique) {
    let answer;
    try {
      answer = await deps.defaultBranchHas(
        location.owner,
        location.repo,
        commit,
      );
    } catch (error) {
      problems.push(
        `whether the attested commit ${commit} is on the default branch could not be read: ${error.message}`,
      );
      continue;
    }
    if (!answer.has) {
      problems.push(
        `the artifact's build attestation names the commit ${commit}, which is not on ${answer.branch} of ${location.owner}/${location.repo}; release only what ${answer.branch} has merged.`,
      );
    }
  }
  return problems;
}

/**
 * Where on GitHub the artifact is, or why the URL is not a release asset.
 *
 * Read from the URL as written: a listing is one exact address, so percent
 * encoding, credentials, a port, a query or a fragment are all refused rather
 * than normalized.
 */
export function releaseLocation(url, version) {
  const tag = `v${version}`;
  const expected = `https://github.com/<owner>/<repo>/releases/download/${tag}/<file>.tgz`;
  const refuse = `the artifact URL is not ${expected}.`;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return refuse;
  }
  if (
    parsed.href !== url ||
    parsed.protocol !== "https:" ||
    parsed.host !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return refuse;
  }

  const segments = parsed.pathname.split("/");
  if (segments.length !== 7 || segments[0] !== "") {
    return refuse;
  }
  const [, owner, repo, releases, download, urlTag, file] = segments;
  if (
    releases !== "releases" ||
    download !== "download" ||
    urlTag !== tag ||
    ![owner, repo, file].every((segment) => SEGMENT.test(segment)) ||
    !file.endsWith(".tgz")
  ) {
    return refuse;
  }

  return { owner, repo, tag, file };
}

/** Why the release does not hold the artifact as a listing requires, or null. */
function releaseProblems(release, location, bytes) {
  const where = `${location.owner}/${location.repo} ${location.tag}`;
  if (release === null) {
    return `there is no release ${where}.`;
  }
  if (release.draft || release.prerelease) {
    return `the release ${where} is a draft or a pre-release.`;
  }
  if (release.immutable !== true) {
    return `the release ${where} is not immutable, so its assets could be replaced.`;
  }
  const asset = release.assets.find(
    (candidate) => candidate.name === location.file,
  );
  if (asset === undefined) {
    return `the release ${where} has no asset ${location.file}.`;
  }
  if (asset.size !== bytes) {
    return `the entry states ${String(bytes)} bytes, the release asset is ${String(asset.size)}.`;
  }
  return null;
}

/**
 * A plugin package: it agrees with its entry and passes the SDK's package
 * check, the same one a plugin's own CI runs.
 */
function pluginProblems(entry, bytes, deps) {
  let files;
  try {
    files = deps.themeTools.readThemeArchive(bytes);
  } catch (error) {
    return [`the artifact is not a readable package: ${error.message}`];
  }

  const json = (path) => {
    const file = files.get(path);
    if (file === undefined) {
      return undefined;
    }
    try {
      return JSON.parse(new TextDecoder("utf8").decode(file));
    } catch {
      return undefined;
    }
  };

  const packageJson = json("package.json");
  if (packageJson === undefined) {
    return ["the package has no readable package.json."];
  }

  const parsed = deps.sdk.parsePluginPackage(packageJson);
  const serverPath = parsed.ok
    ? normalizedPath(parsed.value.openbrf.entry.server ?? "")
    : "";
  const server = files.get(serverPath);

  const problems = [
    ...deps.sdk.pluginPackageProblems({
      packageJson,
      files: [...files.keys()],
      serverBundle:
        server === undefined ? null : new TextDecoder("utf8").decode(server),
      locales: { sv: json("locales/sv.json"), en: json("locales/en.json") },
    }),
  ];

  if (parsed.ok) {
    const { name, version, openbrf: manifest } = parsed.value;
    const disagreements = [
      ["package name", entry.packageName, name],
      ["version", entry.version, version],
      ["id", entry.id, manifest.id],
      ["API version", entry.apiVersion, manifest.apiVersion],
      ["permissions", sorted(entry.permissions), sorted(manifest.permissions)],
      [
        "personal data categories",
        sorted(entry.personalData),
        sorted(manifest.personalData),
      ],
      ["actions", actionSet(entry.actions), actionSet(manifest.actions)],
      [
        "protected resource",
        entry.oauthProtectedResource ?? null,
        manifest.oauthProtectedResource ?? null,
      ],
    ];
    for (const [field, listed, packaged] of disagreements) {
      if (canonical(listed) !== canonical(packaged)) {
        problems.push(
          `the entry's ${field} is ${canonical(listed)}, the package's is ${canonical(packaged)}.`,
        );
      }
    }
  }

  return problems;
}

/**
 * A theme package: it agrees with its entry. The lint runs once every theme
 * in the index has been read.
 */
function themeProblems(entry, bytes, deps, themes) {
  const read = deps.themeTools.readThemePackage(bytes);
  if (!read.ok) {
    return read.issues.map(
      (issue) => `the artifact is not a readable theme package: ${issue}`,
    );
  }

  const { manifest } = read.package;
  const problems = [];
  const disagreements = [
    ["name", entry.id, manifest.name],
    ["version", entry.version, manifest.version],
    ["contract", entry.contract ?? null, manifest.contract ?? null],
    ["parent", entry.extends ?? null, manifest.extends ?? null],
  ];
  for (const [field, listed, packaged] of disagreements) {
    if (listed !== packaged) {
      problems.push(
        `the entry's ${field} is ${String(listed)}, the package's is ${String(packaged)}.`,
      );
    }
  }

  if (problems.length === 0) {
    themes.set(entry.id, read.package);
  }
  return problems;
}

/**
 * A declared digest as raw bytes. The two spellings the instance accepts:
 * `sha512-<base64>` and 128 hex characters.
 */
export function parseSha512(declared) {
  const trimmed = declared.trim();
  const sri = SRI_PATTERN.exec(trimmed);
  if (sri !== null) {
    const bytes = Buffer.from(sri[1], "base64");
    if (bytes.length === 64) {
      return bytes;
    }
  } else if (HEX_PATTERN.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  throw new Error(
    'the artifact digest is not "sha512-<base64>" or 128 hex characters.',
  );
}

export function formatSha512(digest) {
  return `sha512-${Buffer.from(digest).toString("base64")}`;
}

function sorted(values) {
  return [...values].sort();
}

/** Actions compared as a set, each with its keys in one order. */
function actionSet(actions) {
  return actions.map(canonical).sort();
}

/** JSON with object keys sorted, so equal values print equally. */
function canonical(value) {
  return JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

function normalizedPath(path) {
  return path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}
