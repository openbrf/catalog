/**
 * The listing checks, offline: packages built here, a release and a download
 * that answer from memory. Run with `node --test check/`, after the core's
 * packages are built at `.core` (or OPENBRF_CORE).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { sdk, themeTools } from "./core.mjs";
import { catalogProblems, releaseLocation } from "./listing.mjs";

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

  it("fails when the release lists another size than the entry and the download", async () => {
    const file = pluginEntry(plugin).artifact.url.split("/").at(-1);
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([pluginFile], {
        release: { assets: [{ name: file, size: plugin.byteLength + 1 }] },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /states \d+ bytes, the release asset is \d+/);
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

  it("reports a release it cannot read on that entry and checks the others", async () => {
    const deps = published([pluginFile, themeFile]);
    const releaseOf = deps.releaseOf;
    deps.releaseOf = async (owner, repo, tag) => {
      if (repo === "openbrf-occupancy") {
        throw new Error("GitHub answered 503.");
      }
      return releaseOf(owner, repo, tag);
    };
    const wrongSize = themeEntry(theme);
    wrongSize.artifact.bytes = theme.byteLength + 1;
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin), wrongSize] },
      deps,
    );
    assert.equal(problems.length, 2);
    assert.match(
      problems[0],
      /^plugin occupancy 1\.0\.0: the release could not be read: GitHub answered 503\.$/,
    );
    assert.match(problems[1], /^theme example-theme 1\.0\.0: .*bytes/);
  });

  it("holds the attestation to the release's repository and tag", async () => {
    const deps = published([pluginFile]);
    const calls = [];
    deps.verifyAttestation = async (_bytes, fileName, repository, tag) => {
      calls.push({ fileName, repository, tag });
      return null;
    };
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, [
      {
        fileName: "occupancy-1.0.0.tgz",
        repository: "example/openbrf-occupancy",
        tag: "v1.0.0",
      },
    ]);
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
    assert.deepEqual(problems, [
      "theme example-theme 1.0.0: extends absent-theme, which is neither the built-in theme nor a theme in this index.",
    ]);
  });

  describe("a theme extending another in the index", () => {
    const child = themeArchive({
      ...THEME_MANIFEST,
      name: "child-theme",
      displayName: "Child",
      extends: "example-theme",
    });
    const childEntry = (overrides = {}) =>
      themeEntry(child, {
        id: "child-theme",
        extends: "example-theme",
        artifact: {
          url: releaseUrl("child-theme", "1.0.0", "child-theme-1.0.0.tgz"),
          sha512: sri(child),
          bytes: child.byteLength,
        },
        ...overrides,
      });
    const childFile = () => ({ url: childEntry().artifact.url, bytes: child });

    it("passes when both pass", async () => {
      const problems = await catalogProblems(
        { version: 1, entries: [themeEntry(theme), childEntry()] },
        published([themeFile, childFile()]),
      );
      assert.deepEqual(problems, []);
    });

    it("is not blamed when its parent fails its checks", async () => {
      const parent = themeEntry(theme);
      parent.artifact.bytes = theme.byteLength + 1;
      const problems = await catalogProblems(
        { version: 1, entries: [parent, childEntry()] },
        published([themeFile, childFile()]),
      );
      const own = problems.filter((problem) => problem.startsWith("theme child-theme"));
      assert.deepEqual(own, [
        "theme child-theme 1.0.0: extends example-theme, which failed its checks, so it is not linted until example-theme passes.",
      ]);
      assert.ok(problems.some((problem) => problem.startsWith("theme example-theme")));
    });

    it("fails when the parent is deprecated and it is not", async () => {
      const problems = await catalogProblems(
        {
          version: 1,
          entries: [themeEntry(theme, { deprecated: true }), childEntry()],
        },
        published([themeFile, childFile()]),
      );
      assert.deepEqual(problems, [
        "theme child-theme 1.0.0: extends example-theme, which is deprecated in this index, so a new install cannot install example-theme.",
      ]);
    });

    describe("through a theme in between", () => {
      const grandchild = themeArchive({
        ...THEME_MANIFEST,
        name: "grandchild-theme",
        displayName: "Grandchild",
        extends: "child-theme",
      });
      const grandchildEntry = themeEntry(grandchild, {
        id: "grandchild-theme",
        extends: "child-theme",
        artifact: {
          url: releaseUrl("grandchild-theme", "1.0.0", "grandchild-theme-1.0.0.tgz"),
          sha512: sri(grandchild),
          bytes: grandchild.byteLength,
        },
      });
      const grandchildFile = { url: grandchildEntry.artifact.url, bytes: grandchild };
      const own = (problems) =>
        problems.filter((problem) => problem.startsWith("theme grandchild-theme"));

      it("passes when all three pass", async () => {
        const problems = await catalogProblems(
          { version: 1, entries: [themeEntry(theme), childEntry(), grandchildEntry] },
          published([themeFile, childFile(), grandchildFile]),
        );
        assert.deepEqual(problems, []);
      });

      it("is not linted when the theme at the top fails its checks", async () => {
        const top = themeEntry(theme);
        top.artifact.bytes = theme.byteLength + 1;
        const problems = await catalogProblems(
          { version: 1, entries: [top, childEntry(), grandchildEntry] },
          published([themeFile, childFile(), grandchildFile]),
        );
        assert.deepEqual(own(problems), [
          "theme grandchild-theme 1.0.0: extends child-theme, which extends example-theme, which failed its checks, so it is not linted until example-theme passes.",
        ]);
      });

      it("is not linted when the theme in between extends one not in the index", async () => {
        const orphan = themeArchive({
          ...THEME_MANIFEST,
          name: "child-theme",
          displayName: "Child",
          extends: "absent-theme",
        });
        const orphanEntry = childEntry({
          extends: "absent-theme",
          artifact: { ...childEntry().artifact, sha512: sri(orphan), bytes: orphan.byteLength },
        });
        const problems = await catalogProblems(
          { version: 1, entries: [orphanEntry, grandchildEntry] },
          published([{ url: orphanEntry.artifact.url, bytes: orphan }, grandchildFile]),
        );
        assert.deepEqual(problems, [
          "theme child-theme 1.0.0: extends absent-theme, which is neither the built-in theme nor a theme in this index.",
          "theme grandchild-theme 1.0.0: extends child-theme, which failed its checks, so it is not linted until child-theme passes.",
        ]);
      });

      it("fails when the theme at the top is deprecated and it is not", async () => {
        const problems = await catalogProblems(
          {
            version: 1,
            entries: [themeEntry(theme, { deprecated: true }), childEntry(), grandchildEntry],
          },
          published([themeFile, childFile(), grandchildFile]),
        );
        assert.deepEqual(problems, [
          "theme child-theme 1.0.0: extends example-theme, which is deprecated in this index, so a new install cannot install example-theme.",
          "theme grandchild-theme 1.0.0: extends child-theme, which extends example-theme, which is deprecated in this index, so a new install cannot install example-theme.",
        ]);
      });
    });

    it("passes when both are deprecated", async () => {
      const problems = await catalogProblems(
        {
          version: 1,
          entries: [
            themeEntry(theme, { deprecated: true }),
            childEntry({ deprecated: true }),
          ],
        },
        published([themeFile, childFile()]),
      );
      assert.deepEqual(problems, []);
    });
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
