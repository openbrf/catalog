/**
 * Checks catalog.json against every rule a listing must meet, over the
 * network: the release each artifact is on, the artifact's bytes and its build
 * attestation.
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
import { catalogProblems } from "./listing.mjs";

const run = promisify(execFile);

const catalogPath = resolve(process.argv[2] ?? "catalog.json");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

/** Only the GitHub API is sent the token; artifacts are public downloads. */
async function releaseOf(owner, repo, tag) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(30_000),
    },
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
 * repository the release is in and to a run on the release's tag. A `gh` that
 * hangs is stopped, and fails the check.
 */
async function verifyAttestation(bytes, fileName, repository, tag) {
  const directory = await mkdtemp(join(tmpdir(), "catalog-check-"));
  const path = join(directory, fileName);
  try {
    await writeFile(path, bytes);
    await run(
      "gh",
      [
        "attestation",
        "verify",
        path,
        "--repo",
        repository,
        "--source-ref",
        `refs/tags/${tag}`,
        "--deny-self-hosted-runners",
      ],
      { env: process.env, timeout: 120_000 },
    );
    return null;
  } catch (error) {
    if (error.killed === true) {
      return "gh attestation verify did not finish within 120 seconds.";
    }
    return (error.stderr || error.message).trim().split("\n").at(-1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const index = JSON.parse(await readFile(catalogPath, "utf8"));
const problems = await catalogProblems(index, {
  sdk,
  themeTools,
  releaseOf,
  fetchArtifact,
  verifyAttestation,
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
