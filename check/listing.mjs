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
 * the core's own packages and the things that do reach out - reading a
 * release, downloading an artifact, verifying an attestation, asking whether a
 * commit is on the default branch, whether a repository is public and what a
 * release repository pins - so the rules are tested offline against fixtures
 * and run for real in CI.
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

/**
 * The file at a package's root in which a package built in a release-only
 * repository names the source it was built from.
 */
export const SOURCE_FILE = "source.json";

const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const HEX_PATTERN = /^[0-9a-f]{128}$/i;
/** A full commit id: SHA-1, or SHA-256 in a repository that uses it. */
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The most unknown fields of a source record one problem names. */
const MAX_NAMED_FIELDS = 5;

/**
 * @typedef {object} ListingDeps
 * @property {typeof import("@openbrf/plugin-sdk")} sdk
 * @property {typeof import("@openbrf/theme-tools")} themeTools
 * @property {(owner: string, repo: string, tag: string) => Promise<Release | null>} releaseOf
 *   The release published under a tag, or null when there is none.
 * @property {(url: string, maxBytes: number) => Promise<Uint8Array>} fetchArtifact
 * @property {(bytes: Uint8Array, fileName: string, repository: string, tag: string, workflow: string) => Promise<Attestation>} verifyAttestation
 *   Whether the bytes carry a build attestation signed by the workflow at that
 *   path in the repository, in a run on the tag. Always asked of the
 *   repository the release is in, never of the source repository a
 *   release-only listing names.
 * @property {(owner: string, repo: string, commit: string) => Promise<DefaultBranch>} defaultBranchHas
 *   Whether a commit is the head of the repository's default branch or an
 *   ancestor of it.
 * @property {(owner: string, repo: string) => Promise<boolean>} repositoryIsPublic
 *   Whether GitHub shows the repository to anyone. False for a private
 *   repository and for one that does not exist, which it does not tell apart.
 * @property {(owner: string, repo: string, commit: string) => Promise<Uint8Array | null>} sourcePinAt
 *   The repository's own `source.json` at a commit, or null when it has none.
 *
 * @typedef {{ ok: true, commits: unknown[], sources: unknown[] } | { ok: false, reason: string }} Attestation
 *   When it verifies, the commits its attestations name, as the certificates
 *   state them: in `commits` the source each was built from and the commit the
 *   signing workflow was read at, in `sources` the source each was built from
 *   alone.
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
    return parsed.issues.map((issue) => oneLine(`catalog.json: ${issue}`));
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
    const deprecated = ancestors.find(
      (ancestor) => ancestor.deprecated === true,
    );
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

  return problems.map(oneLine);
}

/**
 * A problem as one line. A problem quotes text from a listing's package, and a
 * line break in it would start a line of its own in the CI log, which the
 * runner reads for workflow commands.
 */
function oneLine(problem) {
  return problem.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
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

  const provenance = await provenanceProblems(
    attestation.commits,
    location,
    deps,
  );
  if (provenance.length > 0) {
    return provenance;
  }

  const built = { location, sources: attestation.sources };
  return entry.type === "plugin"
    ? pluginProblems(entry, bytes, built, deps)
    : themeProblems(entry, bytes, built, deps, themes);
}

/**
 * Why the attested commits do not tie the artifact to the default branch, or
 * nothing.
 *
 * A tag push runs the release workflow as it is at the tagged commit, so a
 * workflow that checks its own commit is on `main` can be edited on a branch,
 * tagged there and still sign. The catalog asks GitHub instead: every commit
 * an attestation names, the source and the one the workflow was read at, has
 * to be on the repository's default branch, which only a reviewed pull request
 * reaches.
 */
async function provenanceProblems(commits, location, deps) {
  if (commits.length === 0) {
    return [
      "the artifact's build attestation names no commit it was built from.",
    ];
  }
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
async function pluginProblems(entry, bytes, built, deps) {
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
    ...(await sourceProblems(files, built, deps)),
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
      // The board consents to the entry's recipients, purpose included,
      // before anything is downloaded. Absent is none on both sides: a
      // version 1 entry cannot carry them, and a core that does not know
      // them yet reads them from neither.
      [
        "recipients",
        recipientSet(entry.recipients ?? []),
        recipientSet(manifest.recipients ?? []),
      ],
      // Absent is false on both sides, and a core that does not know `ai` yet
      // reads neither, so this holds before and after the core moves.
      ["ai", entry.ai ?? false, manifest.ai ?? false],
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
async function themeProblems(entry, bytes, built, deps, themes) {
  const read = deps.themeTools.readThemePackage(bytes);
  if (!read.ok) {
    return read.issues.map(
      (issue) => `the artifact is not a readable theme package: ${issue}`,
    );
  }

  const { manifest } = read.package;
  const problems = await sourceProblems(read.package.files, built, deps);
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
 * Why the package's record of the source it was built from is not one a
 * listing accepts, or nothing.
 *
 * A package released from a release-only repository names the repository its
 * source is in and the commit it was built from, inside the attested bytes
 * rather than in the release notes, which stay editable on an immutable
 * release. The release workflow writes those bytes, so the attestation fixes
 * the record without proving it: it is the author's statement of the source.
 * Two rules keep that statement from borrowing anyone else's. It names no
 * repository the public can read, because a package whose source is public is
 * released from that repository. And it is a copy of the release repository's
 * own `source.json` at the commit the attestation names, so it is a pin in the
 * public history of the repository that signed it. The source itself may be
 * private, so the check cannot read whether the commit exists. A package
 * without the record, from a repository that pins none, was built from the
 * commit its attestation names.
 */
async function sourceProblems(files, { location, sources }, deps) {
  const file = files.get(SOURCE_FILE);
  const problems =
    file === undefined ? [] : await recordProblems(file, location, deps);

  const commits = Array.isArray(sources) ? [...new Set(sources)] : [];
  if (commits.length === 0) {
    problems.push(
      `the artifact's build attestation names no source commit, at which the ${SOURCE_FILE} of ${location.owner}/${location.repo} would be read.`,
    );
  }
  for (const commit of commits) {
    problems.push(...(await pinProblems(file, location, commit, deps)));
  }
  return problems;
}

/** Why the record itself is not one a listing accepts, or nothing. */
async function recordProblems(file, location, deps) {
  let text;
  let record;
  try {
    text = new TextDecoder("utf8", { fatal: true }).decode(file);
    record = JSON.parse(text);
  } catch {
    return [`the package's ${SOURCE_FILE} is not readable JSON.`];
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return [
      `the package's ${SOURCE_FILE} is not an object naming the source's \`repository\` and \`commit\`.`,
    ];
  }
  // JSON.parse keeps the last of a repeated field, where another reader of
  // the same bytes may keep the first.
  const repeated = repeatedKey(text);
  if (repeated !== undefined) {
    return [
      `the package's ${SOURCE_FILE} names the field ${JSON.stringify(repeated)} more than once.`,
    ];
  }

  const problems = [];
  const unknown = Object.keys(record).filter(
    (field) => field !== "repository" && field !== "commit",
  );
  if (unknown.length > 0) {
    // Quoted: a field name is the package's text, and a line break in it
    // would start a line of its own in the CI log.
    const named = unknown
      .slice(0, MAX_NAMED_FIELDS)
      .map((field) => JSON.stringify(field))
      .join(", ");
    const more =
      unknown.length > MAX_NAMED_FIELDS
        ? ` and ${String(unknown.length - MAX_NAMED_FIELDS)} more`
        : "";
    problems.push(
      `the package's ${SOURCE_FILE} has fields a listing does not define: ${named}${more}.`,
    );
  }

  const repository = sourceRepository(record.repository, location);
  if (typeof repository === "string") {
    problems.push(repository);
  } else {
    const named = `${repository.owner}/${repository.repo}`;
    let isPublic;
    try {
      isPublic = await deps.repositoryIsPublic(
        repository.owner,
        repository.repo,
      );
    } catch (error) {
      problems.push(
        `whether ${named}, which the package's ${SOURCE_FILE} names, is public could not be read: ${error.message}`,
      );
    }
    if (isPublic === true) {
      problems.push(
        `the package's ${SOURCE_FILE} names ${named}, which is public; a package whose source is public is released from its source repository, without ${SOURCE_FILE}.`,
      );
    }
  }

  if (record.commit === undefined) {
    problems.push(
      `the package's ${SOURCE_FILE} names no \`commit\` it was built from.`,
    );
  } else if (
    typeof record.commit !== "string" ||
    !COMMIT_PATTERN.test(record.commit)
  ) {
    problems.push(
      `the package's ${SOURCE_FILE} names the commit ${JSON.stringify(record.commit)}, which is not a full commit id of 40 or 64 lowercase hexadecimal characters.`,
    );
  }
  return problems;
}

/**
 * The GitHub repository a source record names, or why it is not one.
 *
 * Exactly `https://github.com/<owner>/<repository>`, read as written as the
 * artifact URL is. Another host is refused because the check cannot ask it
 * whether the repository is public. The release's own repository is refused: a
 * package built there has its commit named by its attestation, and a record
 * repeating it could only disagree.
 */
function sourceRepository(repository, location) {
  if (repository === undefined) {
    return `the package's ${SOURCE_FILE} names no \`repository\` its source is in.`;
  }
  const refuse = `the package's ${SOURCE_FILE} names the repository ${JSON.stringify(repository)}, which is not https://github.com/<owner>/<repository>.`;
  if (typeof repository !== "string") {
    return refuse;
  }

  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    return refuse;
  }
  if (
    parsed.href !== repository ||
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
  if (segments.length !== 3) {
    return refuse;
  }
  const [, owner, repo] = segments;
  if (
    ![owner, repo].every((segment) => SEGMENT.test(segment)) ||
    repo.endsWith(".git")
  ) {
    return refuse;
  }

  // GitHub reads owner and repository names case-insensitively.
  if (
    `${owner}/${repo}`.toLowerCase() ===
    `${location.owner}/${location.repo}`.toLowerCase()
  ) {
    return `the package's ${SOURCE_FILE} names ${location.owner}/${location.repo}, the repository it is released from; a package built there has no ${SOURCE_FILE}, because its attestation names the commit.`;
  }
  return { owner, repo };
}

/**
 * Why the package's record, or its absence, is not the pin the release
 * repository has at an attested source commit, or nothing.
 *
 * Compared as bytes: the release workflow copies the pin into the package
 * unchanged, so every reader of either file reads the same record.
 */
async function pinProblems(file, location, commit, deps) {
  const where = `${location.owner}/${location.repo}`;
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
    return [
      `the artifact's build attestation names the source ${String(JSON.stringify(commit))}, which is not a commit id.`,
    ];
  }

  let pin;
  try {
    pin = await deps.sourcePinAt(location.owner, location.repo, commit);
  } catch (error) {
    return [
      `the ${SOURCE_FILE} of ${where} at ${commit} could not be read: ${error.message}`,
    ];
  }
  if (pin === null) {
    return file === undefined
      ? []
      : [
          `the package has a ${SOURCE_FILE}, and ${where} has none at ${commit}, the commit its attestation names; a release-only repository pins the source it builds in a ${SOURCE_FILE} of its own, and the package carries a copy.`,
        ];
  }
  if (file === undefined) {
    return [
      `${where} pins a source in its ${SOURCE_FILE} at ${commit}, the commit its attestation names, and the package carries no copy of it.`,
    ];
  }
  if (!Buffer.from(file).equals(Buffer.from(pin))) {
    return [
      `the package's ${SOURCE_FILE} is not a copy of the one ${where} has at ${commit}, the commit its attestation names; the release workflow copies the pin into the package unchanged.`,
    ];
  }
  return [];
}

/**
 * The first field the top-level object of valid JSON text names twice, or
 * undefined. Strings are skipped whole, so braces and colons inside them are
 * not read as structure.
 */
function repeatedKey(text) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      let next = end + 1;
      while (" \t\n\r".includes(text[next])) {
        next += 1;
      }
      if (depth === 1 && text[next] === ":") {
        const key = JSON.parse(text.slice(index, end + 1));
        if (keys.has(key)) {
          return key;
        }
        keys.add(key);
      }
      index = end;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  return undefined;
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

/** Recipients compared as a set, each with its categories in one order. */
function recipientSet(recipients) {
  return recipients
    .map((recipient) =>
      canonical({ ...recipient, personalData: sorted(recipient.personalData) }),
    )
    .sort();
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
