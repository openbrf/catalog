/**
 * The listing checks, offline: packages built here, a release and a download
 * that answer from memory. Run with `node --test check/`, after the core's
 * packages are built at `.core` (or OPENBRF_CORE).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { catalogProblems, releaseLocation } from "./listing.mjs";

const core = resolve(process.env.OPENBRF_CORE ?? ".core");
const load = (path) => import(pathToFileURL(join(core, path)).href);
const sdk = await load("packages/plugin-sdk/dist/index.js");
const themeTools = await load("packages/theme-tools/dist/index.js");

const encode = (value) =>
  new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );

const PLUGIN_PACKAGE = {
  name: "@example/openbrf-occupancy",
  version: "1.0.0",
  peerDependencies: { "@nestjs/common": "^12.0.0" },
  openbrf: {
    apiVersion: 1,
    id: "occupancy",
    entry: { server: "./dist/server.cjs" },
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
  },
};

function pluginArchive(packageJson = PLUGIN_PACKAGE) {
  return themeTools.writeThemeArchive(
    new Map([
      ["package/package.json", encode(packageJson)],
      [
        "package/dist/server.cjs",
        encode(
          'const common = require("@nestjs/common");\nexports.createPlugin = () => ({});\n',
        ),
      ],
      ["package/locales/sv.json", encode({ title: "Boende" })],
      ["package/locales/en.json", encode({ title: "Occupancy" })],
    ]),
  );
}

function themeArchive(manifest) {
  return themeTools.writeThemeArchive(
    new Map([["theme.json", encode(manifest)]]),
  );
}

const THEME_MANIFEST = {
  name: "example-theme",
  displayName: "Example",
  version: "1.0.0",
  contract: "^1.0.0",
  extends: "porttavlan",
  modes: {
    light: { "accent-trust": "#2F5D50" },
    dark: { "accent-trust": "#7FBFAA" },
  },
};

const TEXT = {
  name: { sv: "Namn", en: "Name" },
  description: { sv: "Beskrivning", en: "Description" },
};

const sri = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function releaseUrl(repo, version, file) {
  return `https://github.com/example/${repo}/releases/download/v${version}/${file}`;
}

function pluginEntry(bytes, overrides = {}) {
  return {
    type: "plugin",
    id: "occupancy",
    packageName: "@example/openbrf-occupancy",
    version: "1.0.0",
    apiVersion: 1,
    ...TEXT,
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
    artifact: {
      url: releaseUrl("openbrf-occupancy", "1.0.0", "occupancy-1.0.0.tgz"),
      sha512: sri(bytes),
      bytes: bytes.byteLength,
    },
    ...overrides,
  };
}

function themeEntry(bytes, overrides = {}) {
  return {
    type: "theme",
    id: "example-theme",
    version: "1.0.0",
    ...TEXT,
    contract: "^1.0.0",
    extends: "porttavlan",
    artifact: {
      url: releaseUrl("example-theme", "1.0.0", "example-theme-1.0.0.tgz"),
      sha512: sri(bytes),
      bytes: bytes.byteLength,
    },
    ...overrides,
  };
}

/**
 * Dependencies answering from a set of published files: each URL is an asset
 * of an immutable release holding exactly those bytes, with an attestation.
 */
function published(files, options = {}) {
  const byUrl = new Map(files.map((file) => [file.url, file.bytes]));
  return {
    sdk,
    themeTools,
    async releaseOf(owner, repo, tag) {
      const prefix = `https://github.com/${owner}/${repo}/releases/download/${tag}/`;
      const assets = files
        .filter((file) => file.url.startsWith(prefix))
        .map((file) => ({
          name: file.url.slice(prefix.length),
          size: file.bytes.byteLength,
        }));
      if (assets.length === 0) {
        return null;
      }
      return {
        draft: false,
        prerelease: false,
        immutable: true,
        assets,
        ...options.release,
      };
    },
    async fetchArtifact(url) {
      const bytes = byUrl.get(url);
      if (bytes === undefined) {
        throw new Error(`${url} answered 404.`);
      }
      return bytes;
    },
    async verifyAttestation() {
      return options.attestation ?? null;
    },
  };
}

const plugin = pluginArchive();
const theme = themeArchive(THEME_MANIFEST);
const pluginFile = { url: pluginEntry(plugin).artifact.url, bytes: plugin };
const themeFile = { url: themeEntry(theme).artifact.url, bytes: theme };

describe("catalog.json in this repository", () => {
  it("is an index the instance reads", () => {
    const index = JSON.parse(readFileSync("catalog.json", "utf8"));
    const parsed = sdk.parseCatalogIndex(index);
    assert.deepEqual(parsed.ok ? [] : parsed.issues, []);
  });
});

describe("a listing", () => {
  it("passes when the artifact is the one the entry states", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin), themeEntry(theme)] },
      published([pluginFile, themeFile]),
    );
    assert.deepEqual(problems, []);
  });

  it("fails when the digest is not the artifact's", async () => {
    const other = sri(encode("something else"));
    const entry = pluginEntry(plugin);
    entry.artifact.sha512 = other;
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([pluginFile]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states sha512-.*, the artifact is sha512-/);
  });

  it("fails when the digest is written in hex and is not the artifact's", async () => {
    const entry = themeEntry(theme);
    entry.artifact.sha512 = "ab".repeat(64);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([themeFile]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the artifact is sha512-/);
  });

  it("fails when the size is not the artifact's", async () => {
    const entry = themeEntry(theme);
    entry.artifact.bytes = theme.byteLength + 1;
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([themeFile]),
    );
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => /bytes/.test(problem)));
  });

  it("fails when the download is not the size the release lists", async () => {
    const deps = published([pluginFile]);
    const longer = new Uint8Array([...plugin, 0]);
    deps.fetchArtifact = async () => longer;
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /states \d+ bytes, the artifact is \d+/);
    assert.match(problems[1], /the artifact is sha512-/);
  });

  it("fails when it states no size", async () => {
    const entry = pluginEntry(plugin);
    delete entry.artifact.bytes;
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([pluginFile]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states no size/);
  });

  it("fails when the index is not one the instance reads", async () => {
    const entry = { ...pluginEntry(plugin), sha256: "x" };
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([pluginFile]),
    );
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => problem.startsWith("catalog.json:")));
  });

  it("fails when an id is listed twice", async () => {
    const problems = await catalogProblems(
      {
        version: 1,
        entries: [pluginEntry(plugin), themeEntry(theme, { id: "occupancy" })],
      },
      published([pluginFile, themeFile]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /appears once in the index/);
  });

  it("fails when the release is a pre-release or not immutable", async () => {
    for (const release of [{ prerelease: true }, { immutable: false }]) {
      const problems = await catalogProblems(
        { version: 1, entries: [pluginEntry(plugin)] },
        published([pluginFile], { release }),
      );
      assert.equal(problems.length, 1, JSON.stringify(release));
    }
  });

  it("fails when there is no such release", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /there is no release example\/openbrf-occupancy v1\.0\.0/);
  });

  it("fails when the attestation does not verify", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([pluginFile], { attestation: "no attestation found" }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /attestation does not verify/);
  });

  it("fails when the plugin asks for more than the entry declares", async () => {
    const wider = pluginArchive({
      ...PLUGIN_PACKAGE,
      openbrf: {
        ...PLUGIN_PACKAGE.openbrf,
        personalData: ["name", "apartment", "residency"],
      },
    });
    const entry = pluginEntry(wider);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes: wider }]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /personal data categories/);
  });

  it("fails when the plugin fails the package check", async () => {
    const withDependency = pluginArchive({
      ...PLUGIN_PACKAGE,
      dependencies: { "left-pad": "1.3.0" },
    });
    const entry = pluginEntry(withDependency);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes: withDependency }]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /left-pad under dependencies/);
  });

  it("fails when the theme names itself differently from its entry", async () => {
    const renamed = themeArchive({ ...THEME_MANIFEST, name: "other-theme" });
    const entry = themeEntry(renamed);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes: renamed }]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /name is example-theme, the package's is other-theme/);
  });

  it("fails when the theme's parent is not in the index", async () => {
    const child = themeArchive({ ...THEME_MANIFEST, extends: "absent-theme" });
    const entry = themeEntry(child, { extends: "absent-theme" });
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes: child }]),
    );
    assert.ok(problems.some((problem) => /absent-theme, which is neither/.test(problem)));
  });

  it("fails when the theme fails the install lint", async () => {
    const illegible = themeArchive({
      ...THEME_MANIFEST,
      modes: {
        light: { "text-primary": "#FEFEFE", "surface-page": "#FFFFFF" },
        dark: {},
      },
    });
    const entry = themeEntry(illegible);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes: illegible }]),
    );
    assert.ok(problems.length > 0);
    assert.ok(problems.every((problem) => /install lint refuses/.test(problem)));
  });
});

describe("an artifact URL", () => {
  const good = releaseUrl("repo", "1.2.3", "pkg-1.2.3.tgz");

  it("is a release asset under the tag v<version>", () => {
    assert.deepEqual(releaseLocation(good, "1.2.3"), {
      owner: "example",
      repo: "repo",
      tag: "v1.2.3",
      file: "pkg-1.2.3.tgz",
    });
  });

  for (const [why, url, version] of [
    ["another tag", good, "1.2.4"],
    ["http", good.replace("https:", "http:"), "1.2.3"],
    ["another host", good.replace("github.com", "example.com"), "1.2.3"],
    ["a query", `${good}?x=1`, "1.2.3"],
    ["credentials", good.replace("https://", "https://user@"), "1.2.3"],
    ["encoding", good.replace("pkg-", "pkg%2D"), "1.2.3"],
    ["a dot segment", good.replace("/example/", "/example/../example/"), "1.2.3"],
    ["not a tarball", good.replace(".tgz", ".zip"), "1.2.3"],
    ["a raw file", "https://github.com/example/repo/raw/main/pkg.tgz", "1.2.3"],
  ]) {
    it(`is refused with ${why}`, () => {
      assert.equal(typeof releaseLocation(url, version), "string");
    });
  }
});
