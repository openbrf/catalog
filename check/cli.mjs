/**
 * Checks catalog.json against every rule a listing must meet, over the
 * network: the release each artifact is on, the artifact's bytes and its build
 * attestation, whether the commit that attestation names is on the
 * repository's default branch, and for a release-only listing whether the
 * source it names is public and what its release repository pins.
 *
 *   node check/cli.mjs [catalog.json]
 *
 * Reads the index schema and the package checks from a checkout of
 * openbrf/openbrf with its plugin-sdk and theme-tools built, at `.core` or
 * wherever OPENBRF_CORE points. GH_TOKEN is used for the GitHub API and for
 * `gh attestation verify`.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { sdk, themeTools } from "./core.mjs";
import { SOURCE_FILE, catalogProblems } from "./listing.mjs";

const run = promisify(execFile);

const catalogPath = resolve(process.argv[2] ?? "catalog.json");
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
  // claims as GitHub's OIDC token stated them.
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
  const certificates = results.map(
    (result) => result?.verificationResult?.signature?.certificate,
  );
  return {
    ok: true,
    commits: certificates.flatMap((certificate) => [
      certificate?.sourceRepositoryDigest,
      certificate?.buildSignerDigest,
    ]),
    sources: certificates.map(
      (certificate) => certificate?.sourceRepositoryDigest,
    ),
  };
}

/** The default branch of each repository asked about, read once. */
const defaultBranches = new Map();

/**
 * Whether the commit is on the repository's default branch, by GitHub's
 * comparison of the branch with it: `identical` or `behind` when the branch
 * contains it. A commit GitHub does not know is not on it.
 */
async function defaultBranchHas(owner, repo, commit) {
  const repository = `${owner}/${repo}`;
  let branch = defaultBranches.get(repository);
  if (branch === undefined) {
    const response = await githubApi(`/repos/${repository}`);
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${String(response.status)} for the repository ${repository}.`,
      );
    }
    branch = (await response.json()).default_branch;
    if (typeof branch !== "string" || branch === "") {
      throw new Error(`GitHub names no default branch for ${repository}.`);
    }
    defaultBranches.set(repository, branch);
  }

  const response = await githubApi(
    `/repos/${repository}/compare/${encodeURIComponent(branch)}...${commit}?per_page=1`,
  );
  if (response.status === 404) {
    return { branch, has: false };
  }
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${String(response.status)} comparing ${branch} with ${commit} in ${repository}.`,
    );
  }
  const { status } = await response.json();
  return { branch, has: status === "identical" || status === "behind" };
}

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

const index = JSON.parse(await readFile(catalogPath, "utf8"));
const problems = await catalogProblems(index, {
  sdk,
  themeTools,
  releaseOf,
  fetchArtifact,
  verifyAttestation,
  defaultBranchHas,
  repositoryIsPublic,
  sourcePinAt,
});

if (problems.length > 0) {
  console.error(`${catalogPath} does not pass the listing checks:\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exitCode = 1;
} else {
  const count = index.entries.length;
  console.log(
    `${catalogPath}: ${String(count)} ${count === 1 ? "entry passes" : "entries pass"} the listing checks.`,
  );
}
