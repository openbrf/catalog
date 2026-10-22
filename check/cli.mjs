/**
 * Checks the catalog's index files, catalog.json (index version 1) and
 * catalog-v2.json (version 2), against every rule a listing must meet, over the
 * network: the release each artifact is on, the artifact's bytes and its build
 * attestation, whether the commits that attestation names are on the
 * repository's default branch, for a release-only listing whether the source
 * it names is public and what its release repository pins, and for a licensed
 * plugin what its issuer publishes.
 *
 *   node check/cli.mjs [--pins repositories.json] [index.json ...]
 *
 * With no index named, both catalog.json and catalog-v2.json are checked.
 *
 * Reads the index schema and the package checks from a checkout of
 * openbrf/openbrf with its plugin-sdk and theme-tools built, at `.core` or
 * wherever OPENBRF_CORE points. GH_TOKEN is used for the GitHub API and for
 * `gh attestation verify`.
 */
import { execFile } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { defaultBranchChecker } from "./branch.mjs";
import { sdk, themeTools } from "./core.mjs";
import {
  SOURCE_FILE,
  catalogProblems,
  parseRepositoryPins,
} from "./listing.mjs";

const run = promisify(execFile);

/** The index files this repository publishes, one for each index version. */
const INDEX_FILES = ["catalog.json", "catalog-v2.json"];

/** The index version each of those files must carry. */
const INDEX_VERSIONS = new Map([
  ["catalog.json", 1],
  ["catalog-v2.json", 2],
]);

/** The most bytes read of an index file or of the repositories file. */
const MAX_JSON_BYTES = 1024 * 1024;

const args = process.argv.slice(2);
const pinsFlag = args.indexOf("--pins");
const pinsArgument = pinsFlag === -1 ? undefined : args[pinsFlag + 1];
if (pinsFlag !== -1) {
  if (pinsArgument === undefined) {
    console.error("--pins needs the path of the repositories file.");
    process.exit(2);
  }
  args.splice(pinsFlag, 2);
}
const pinsPath = resolve(pinsArgument ?? "repositories.json");
const indexPaths = (args.length === 0 ? INDEX_FILES : args).map((path) =>
  resolve(path),
);
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;

/** How long `gh attestation verify` may run. */
const ATTESTATION_TIMEOUT_MS = 120_000;

/** The most bytes read of a release repository's `source.json`. */
const MAX_PIN_BYTES = 64 * 1024;

/** Only the GitHub API is sent the token; artifacts are public downloads. */
function githubApi(path) {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function releaseOf(owner, repo, tag) {
  const response = await githubApi(
    `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${String(response.status)} for the release ${owner}/${repo} ${tag}.`,
    );
  }
  const release = await response.json();
  return {
    draft: release.draft === true,
    prerelease: release.prerelease === true,
    immutable: release.immutable === true,
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
    })),
  };
}

/**
 * Downloads at most `maxBytes`, whatever the server says the length is. The
 * deadline covers reading the body as well as the headers.
 */
async function fetchArtifact(url, maxBytes) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`${url} answered ${String(response.status)}.`);
  }
  return readAtMost(response, url, maxBytes);
}

/** A response's body, refused once it passes `maxBytes`. */
async function readAtMost(response, url, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`${url} is over the ${String(maxBytes)} byte limit.`);
    }
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * `gh attestation verify` on the downloaded bytes, holding the signer to the
 * release workflow at its path in the repository the release is in, and to a
 * run on the release's tag. A `gh` that hangs is stopped, and fails the check.
 */
async function verifyAttestation(bytes, fileName, repository, tag, workflow) {
  const directory = await mkdtemp(join(tmpdir(), "catalog-check-"));
  const path = join(directory, fileName);
  let stdout;
  try {
    await writeFile(path, bytes);
    ({ stdout } = await run(
      "gh",
      [
        "attestation",
        "verify",
        path,
        "--repo",
        repository,
        "--signer-workflow",
        `${repository}/${workflow}`,
        "--source-ref",
        `refs/tags/${tag}`,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      { env: process.env, timeout: ATTESTATION_TIMEOUT_MS },
    ));
  } catch (error) {
    // Output over `maxBuffer` stops `gh` too, and is told apart by its code.
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        ok: false,
        reason: "gh attestation verify wrote more output than the check reads.",
      };
    }
    if (error.killed === true && error.signal === "SIGTERM") {
      return {
        ok: false,
        reason: `gh attestation verify did not finish within ${String(ATTESTATION_TIMEOUT_MS / 1000)} seconds.`,
      };
    }
    return {
      ok: false,
      reason: (error.stderr || error.message).trim().split("\n").at(-1),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // One result per attestation that verified, each with the certificate's
  // claims as GitHub's OIDC token stated them. The listing checks compare
  // those claims themselves rather than trust how this gh matches its flags.
  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    results = undefined;
  }
  if (!Array.isArray(results)) {
    return {
      ok: false,
      reason: "gh attestation verify wrote output the check cannot read.",
    };
  }
  return {
    ok: true,
    certificates: results.map(
      (result) => result?.verificationResult?.signature?.certificate,
    ),
  };
}

const defaultBranchHas = defaultBranchChecker(githubApi);

/**
 * Whether GitHub reports the repository public. Asked with the token, which
 * GitHub still answers `private` for a private repository the token can read;
 * one it does not show at all is not public.
 */
async function repositoryIsPublic(owner, repo) {
  const response = await githubApi(`/repos/${owner}/${repo}`);
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${String(response.status)} for the repository ${owner}/${repo}.`,
    );
  }
  return (await response.json()).private === false;
}

/**
 * The repository's own `source.json` at a commit, or null when it has none. A
 * public download, as an artifact is: the release repository is public.
 */
async function sourcePinAt(owner, repo, commit) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${SOURCE_FILE}`;
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok || response.body === null) {
    throw new Error(`${url} answered ${String(response.status)}.`);
  }
  return readAtMost(response, url, MAX_PIN_BYTES);
}

/**
 * The document a licence's issuer publishes at its `issuer.url`. Never sent
 * the token, and a redirect is refused rather than followed: the document is
 * the one that address answers, so whoever holds the address is who vouches.
 */
async function issuerDocumentAt(url, maxBytes) {
  const response = await fetch(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`${url} answered ${String(response.status)}.`);
  }
  return readAtMost(response, url, maxBytes);
}

/**
 * A JSON file, opened once so that what is measured is what is read, and
 * refused when it is not a regular file or is over `MAX_JSON_BYTES`.
 */
async function readJson(path) {
  const file = await open(path, "r");
  try {
    const tooLarge = new Error(
      `${path} is over the ${String(MAX_JSON_BYTES)} byte limit.`,
    );
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`${path} is not a regular file.`);
    }
    if (stats.size > MAX_JSON_BYTES) {
      throw tooLarge;
    }
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_JSON_BYTES) {
      throw tooLarge;
    }
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally {
    await file.close();
  }
}

const pins = parseRepositoryPins(await readJson(pinsPath));
if (!pins.ok) {
  console.error(`${pinsPath} is not a list of repositories:\n`);
  for (const issue of pins.issues) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

for (const indexPath of indexPaths) {
  const index = await readJson(indexPath);
  // Each file this repository publishes is the one an instance of its version
  // reads, so the other version in it is refused whatever the schema accepts.
  const version = INDEX_VERSIONS.get(basename(indexPath));
  if (version !== undefined && index?.version !== version) {
    console.error(
      `${indexPath} must be an index of version ${String(version)}.`,
    );
    process.exitCode = 1;
    continue;
  }
  const problems = await catalogProblems(index, {
    indexName: basename(indexPath),
    repositoryPins: pins.pins,
    sdk,
    themeTools,
    releaseOf,
    fetchArtifact,
    verifyAttestation,
    defaultBranchHas,
    repositoryIsPublic,
    sourcePinAt,
    issuerDocumentAt,
  });

  if (problems.length > 0) {
    console.error(`${indexPath} does not pass the listing checks:\n`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exitCode = 1;
  } else {
    const count = index.entries.length;
    console.log(
      `${indexPath}: ${String(count)} ${count === 1 ? "entry passes" : "entries pass"} the listing checks.`,
    );
  }
}
