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
 * the core's own packages and the three things that do reach out - reading a
 * release, downloading an artifact, verifying an attestation - so the rules are
 * tested offline against fixtures and run for real in CI.
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

const SRI_PATTERN = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const HEX_PATTERN = /^[0-9a-f]{128}$/i;

/**
 * @typedef {object} ListingDeps
 * @property {typeof import("@openbrf/plugin-sdk")} sdk
 * @property {typeof import("@openbrf/theme-tools")} themeTools
 * @property {(owner: string, repo: string, tag: string) => Promise<Release | null>} releaseOf
 *   The release published under a tag, or null when there is none.
 * @property {(url: string, maxBytes: number) => Promise<Uint8Array>} fetchArtifact
 * @property {(bytes: Uint8Array, fileName: string, repository: string, tag: string) => Promise<string | null>} verifyAttestation
 *   Null when the bytes carry a build attestation from a run on the tag in the
 *   repository, else why not.
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
    const parent = entry.extends;
    const listedParent =
      parent === undefined ? undefined : themeEntries.get(parent);
    if (
      parent !== undefined &&
      parent !== deps.themeTools.BUILT_IN_THEME_ID &&
      listedParent === undefined
    ) {
      problems.push(
        `${label}: extends ${parent}, which is neither the built-in theme nor a theme in this index.`,
      );
    } else if (listedParent?.deprecated === true && entry.deprecated !== true) {
      // An instance installs no deprecated entry anew, so on a new instance
      // the parent cannot be installed and neither can this theme.
      problems.push(
        `${label}: extends ${parent}, which is deprecated in this index, so a new install cannot install its parent.`,
      );
    }

    const pkg = themes.get(entry.id);
    if (pkg === undefined) {
      continue;
    }
    if (listedParent !== undefined && !themes.has(listedParent.id)) {
      // Linted without its parent, the theme would be refused for the
      // parent's fault; the parent's own problems are reported above.
      problems.push(
        `${label}: its parent ${parent} failed its checks, so it is not linted until the parent passes.`,
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
  );
  if (attestation !== null) {
    return [`the artifact's build attestation does not verify: ${attestation}`];
  }

  return entry.type === "plugin"
    ? pluginProblems(entry, bytes, deps)
    : themeProblems(entry, bytes, deps, themes);
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
  const asset = release.assets.find((candidate) => candidate.name === location.file);
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
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
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
