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
import {
  RELEASE_WORKFLOW,
  SOURCE_FILE,
  catalogProblems,
  releaseLocation,
} from "./listing.mjs";

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

/** `extra` maps a path in the package to its content. */
function pluginArchive(packageJson = PLUGIN_PACKAGE, extra = {}) {
  return themeTools.writeThemeArchive(
    new Map([
      ...Object.entries(extra).map(([path, content]) => [
        `package/${path}`,
        encode(content),
      ]),
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

function themeArchive(manifest, extra = {}) {
  return themeTools.writeThemeArchive(
    new Map([
      ["theme.json", encode(manifest)],
      ...Object.entries(extra).map(([path, content]) => [
        path,
        encode(content),
      ]),
    ]),
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

/** The commit every fixture attestation names unless a test says otherwise. */
const ON_MAIN = "a".repeat(40);
/** A commit on a branch that never merged. */
const OFF_MAIN = "b".repeat(40);

/**
 * Dependencies answering from a set of published files: each URL is an asset
 * of an immutable release holding exactly those bytes, with an attestation
 * built from a commit on main. `options.pin` is the `source.json` every
 * release repository has at every commit, none by default, and
 * `options.public` the repositories GitHub shows to anyone.
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
      return (
        options.attestation ?? {
          ok: true,
          commits: [ON_MAIN, ON_MAIN],
          sources: [ON_MAIN],
        }
      );
    },
    async defaultBranchHas(_owner, _repo, commit) {
      return { branch: "main", has: commit === ON_MAIN };
    },
    async repositoryIsPublic(owner, repo) {
      return (options.public ?? []).includes(`${owner}/${repo}`);
    },
    async sourcePinAt() {
      return options.pin ?? null;
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
    assert.match(
      problems[0],
      /there is no release example\/openbrf-occupancy v1\.0\.0/,
    );
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
    deps.verifyAttestation = async (
      _bytes,
      fileName,
      repository,
      tag,
      workflow,
    ) => {
      calls.push({ fileName, repository, tag, workflow });
      return { ok: true, commits: [ON_MAIN, ON_MAIN], sources: [ON_MAIN] };
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
        workflow: ".github/workflows/release.yml",
      },
    ]);
    assert.equal(RELEASE_WORKFLOW, ".github/workflows/release.yml");
  });

  it("fails when the attestation does not verify", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([pluginFile], {
        attestation: { ok: false, reason: "no attestation found" },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /attestation does not verify as made by \.github\/workflows\/release\.yml of example\/openbrf-occupancy in a run on v1\.0\.0, on a GitHub-hosted runner: no attestation found$/,
    );
  });

  // A tag push runs the workflow as the tagged commit has it, so its own check
  // that the commit is on main can be deleted on a branch that is then tagged.
  it("fails when the attested source is a commit main does not have", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin), themeEntry(theme)] },
      published([pluginFile, themeFile], {
        attestation: { ok: true, commits: [OFF_MAIN, OFF_MAIN] },
      }),
    );
    assert.equal(problems.length, 2);
    assert.match(
      problems[0],
      /^plugin occupancy 1\.0\.0: the artifact's build attestation names the commit b{40}, which is not on main of example\/openbrf-occupancy;/,
    );
    assert.match(
      problems[1],
      /^theme example-theme 1\.0\.0: .*b{40}, which is not on main/,
    );
  });

  it("fails when the signing workflow was read at a commit main does not have", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([pluginFile], {
        attestation: { ok: true, commits: [ON_MAIN, OFF_MAIN] },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /names the commit b{40}, which is not on main/);
  });

  it("fails when any of several attestations is off main", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      published([pluginFile], {
        attestation: {
          ok: true,
          commits: [ON_MAIN, ON_MAIN, OFF_MAIN, OFF_MAIN],
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /b{40}, which is not on main/);
  });

  it("asks about each attested commit once, in the release's repository", async () => {
    const deps = published([pluginFile], {
      attestation: {
        ok: true,
        commits: [ON_MAIN, ON_MAIN, ON_MAIN],
        sources: [ON_MAIN],
      },
    });
    const calls = [];
    deps.defaultBranchHas = async (owner, repo, commit) => {
      calls.push({ owner, repo, commit });
      return { branch: "main", has: true };
    };
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, [
      { owner: "example", repo: "openbrf-occupancy", commit: ON_MAIN },
    ]);
  });

  it("fails when the attestation names no commit, or something else", async () => {
    for (const commits of [
      [],
      [undefined, undefined],
      [ON_MAIN, "main"],
      [ON_MAIN.toUpperCase(), ON_MAIN.toUpperCase()],
      [`${ON_MAIN}/../x`, ON_MAIN],
    ]) {
      const deps = published([pluginFile], {
        attestation: { ok: true, commits },
      });
      deps.defaultBranchHas = async () => {
        throw new Error("not asked about a malformed commit");
      };
      const problems = await catalogProblems(
        { version: 1, entries: [pluginEntry(plugin)] },
        deps,
      );
      assert.equal(problems.length, 1, JSON.stringify(commits));
      assert.match(
        problems[0],
        /names no commit it was built from|which is not a commit id/,
        JSON.stringify(commits),
      );
    }
  });

  it("fails when GitHub cannot say whether main has the commit", async () => {
    const deps = published([pluginFile]);
    deps.defaultBranchHas = async () => {
      throw new Error("GitHub answered 503.");
    };
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /a{40} is on the default branch could not be read: GitHub answered 503\.$/,
    );
  });

  it("names the default branch GitHub reports", async () => {
    const deps = published([pluginFile]);
    deps.defaultBranchHas = async () => ({ branch: "trunk", has: false });
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /which is not on trunk of .*; release only what trunk has merged\.$/,
    );
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

  describe("a plugin's recipients", () => {
    const RATES = {
      id: "rates",
      origin: "https://rates.example.com",
      purpose: { sv: "Dagens kurser", en: "The day's rates" },
      personalData: [],
    };
    const MAIL = {
      id: "mail",
      origin: "https://mail.example.com",
      purpose: { sv: "Skicka utskick", en: "Send mailings" },
      personalData: ["name", "apartment"],
    };

    // A core older than `recipients` reads them from neither side and refuses
    // an index of version 2, so the comparison cannot be shown until CORE_REF
    // moves past it.
    const knowsRecipients =
      sdk.parsePluginPackage({
        ...PLUGIN_PACKAGE,
        openbrf: { ...PLUGIN_PACKAGE.openbrf, recipients: [RATES] },
      }).value?.openbrf.recipients?.length === 1;

    const recipientPackage = (recipients) =>
      pluginArchive({
        ...PLUGIN_PACKAGE,
        openbrf: { ...PLUGIN_PACKAGE.openbrf, recipients },
      });

    async function problemsOf(bytes, overrides, version = 2) {
      const entry = pluginEntry(bytes, overrides);
      return catalogProblems(
        { version, entries: [entry] },
        published([{ url: entry.artifact.url, bytes }]),
      );
    }

    it("passes when the entry and the package both declare none", async () => {
      assert.deepEqual(await problemsOf(plugin, {}, 1), []);
    });

    it(
      "passes when the entry repeats the package's, in any order",
      { skip: !knowsRecipients },
      async () => {
        const bytes = recipientPackage([RATES, MAIL]);
        const reordered = { ...MAIL, personalData: ["apartment", "name"] };
        assert.deepEqual(
          await problemsOf(bytes, { recipients: [reordered, RATES] }),
          [],
        );
      },
    );

    it(
      "fails when the package declares one the entry leaves out",
      { skip: !knowsRecipients },
      async () => {
        const bytes = recipientPackage([RATES, MAIL]);
        const problems = await problemsOf(bytes, { recipients: [RATES] });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /the entry's recipients is .*mail\.example/);
      },
    );

    it(
      "fails when the entry declares one the package does not",
      { skip: !knowsRecipients },
      async () => {
        const problems = await problemsOf(plugin, { recipients: [RATES] });
        assert.equal(problems.length, 1);
        assert.match(
          problems[0],
          /the entry's recipients is .*rates\.example.*, the package's is \[\]\.$/,
        );
      },
    );

    for (const [field, value] of [
      ["origin", "https://api.example.com"],
      ["purpose", { sv: "Kurser", en: "Rates" }],
      ["personalData", ["name"]],
    ]) {
      it(
        `fails when the entry states another ${field} than the package`,
        { skip: !knowsRecipients },
        async () => {
          const bytes = recipientPackage([RATES]);
          const problems = await problemsOf(bytes, {
            recipients: [{ ...RATES, [field]: value }],
          });
          assert.equal(problems.length, 1);
          assert.match(problems[0], /the entry's recipients is /);
        },
      );
    }

    it(
      "fails when an index of version 1 lists a plugin that declares them",
      { skip: !knowsRecipients },
      async () => {
        const bytes = recipientPackage([RATES]);
        const problems = await problemsOf(bytes, {}, 1);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /the package's is .*rates\.example/);
      },
    );

    it(
      "fails when an index of version 1 carries them",
      { skip: !knowsRecipients },
      async () => {
        const bytes = recipientPackage([RATES]);
        const problems = await problemsOf(bytes, { recipients: [RATES] }, 1);
        assert.equal(problems.length, 1);
        assert.match(problems[0], /recipients is not in version 1 of the index/);
      },
    );
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
    assert.match(
      problems[0],
      /name is example-theme, the package's is other-theme/,
    );
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
      const own = problems.filter((problem) =>
        problem.startsWith("theme child-theme"),
      );
      assert.deepEqual(own, [
        "theme child-theme 1.0.0: extends example-theme, which failed its checks, so it is not linted until example-theme passes.",
      ]);
      assert.ok(
        problems.some((problem) => problem.startsWith("theme example-theme")),
      );
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
          url: releaseUrl(
            "grandchild-theme",
            "1.0.0",
            "grandchild-theme-1.0.0.tgz",
          ),
          sha512: sri(grandchild),
          bytes: grandchild.byteLength,
        },
      });
      const grandchildFile = {
        url: grandchildEntry.artifact.url,
        bytes: grandchild,
      };
      const own = (problems) =>
        problems.filter((problem) =>
          problem.startsWith("theme grandchild-theme"),
        );

      it("passes when all three pass", async () => {
        const problems = await catalogProblems(
          {
            version: 1,
            entries: [themeEntry(theme), childEntry(), grandchildEntry],
          },
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
          artifact: {
            ...childEntry().artifact,
            sha512: sri(orphan),
            bytes: orphan.byteLength,
          },
        });
        const problems = await catalogProblems(
          { version: 1, entries: [orphanEntry, grandchildEntry] },
          published([
            { url: orphanEntry.artifact.url, bytes: orphan },
            grandchildFile,
          ]),
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
            entries: [
              themeEntry(theme, { deprecated: true }),
              childEntry(),
              grandchildEntry,
            ],
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
    assert.ok(
      problems.every((problem) => /install lint refuses/.test(problem)),
    );
  });
});

describe("a listing from a release-only repository", () => {
  const SOURCE = {
    repository: "https://github.com/example-private/occupancy",
    commit: "0123456789abcdef0123456789abcdef01234567",
  };
  /** The release repository's own pin, copied into the package as is. */
  const PIN = encode(SOURCE);
  const releaseOnlyPlugin = pluginArchive(PLUGIN_PACKAGE, {
    [SOURCE_FILE]: SOURCE,
  });
  const releaseOnlyTheme = themeArchive(THEME_MANIFEST, {
    [SOURCE_FILE]: SOURCE,
  });

  /** The plugin entry and its published file, with `source` as its record. */
  function withSource(source) {
    const bytes = pluginArchive(PLUGIN_PACKAGE, { [SOURCE_FILE]: source });
    const entry = pluginEntry(bytes);
    return { entry, file: { url: entry.artifact.url, bytes } };
  }

  /**
   * The attestation as `gh attestation verify --repo` answers it: found only
   * when the repository asked for is the one whose workflow signed it.
   */
  function signedIn(signer) {
    return async (_bytes, _fileName, repository) =>
      repository === signer
        ? { ok: true, commits: [ON_MAIN, ON_MAIN], sources: [ON_MAIN] }
        : {
            ok: false,
            reason: `no attestations found for subject in ${repository}`,
          };
  }

  it("passes when the release repository attests the package and it carries the pin", async () => {
    const plugin = pluginEntry(releaseOnlyPlugin);
    const theme = themeEntry(releaseOnlyTheme);
    const deps = published(
      [
        { url: plugin.artifact.url, bytes: releaseOnlyPlugin },
        { url: theme.artifact.url, bytes: releaseOnlyTheme },
      ],
      { pin: PIN },
    );
    const asked = [];
    deps.verifyAttestation = async (_bytes, _fileName, repository) => {
      asked.push(repository);
      return { ok: true, commits: [ON_MAIN, ON_MAIN], sources: [ON_MAIN] };
    };
    const pins = [];
    deps.sourcePinAt = async (owner, repo, commit) => {
      pins.push({ owner, repo, commit });
      return PIN;
    };
    const visibility = [];
    deps.repositoryIsPublic = async (owner, repo) => {
      visibility.push(`${owner}/${repo}`);
      return false;
    };
    const problems = await catalogProblems(
      { version: 1, entries: [plugin, theme] },
      deps,
    );
    assert.deepEqual(problems, []);
    // Held to the repository the release is in, never to the source's.
    assert.deepEqual(asked, [
      "example/openbrf-occupancy",
      "example/example-theme",
    ]);
    // The pin is read in the release repository, at the attested source.
    assert.deepEqual(pins, [
      { owner: "example", repo: "openbrf-occupancy", commit: ON_MAIN },
      { owner: "example", repo: "example-theme", commit: ON_MAIN },
    ]);
    assert.deepEqual(visibility, [
      "example-private/occupancy",
      "example-private/occupancy",
    ]);
  });

  it("fails when the attestation comes from the source repository, not its own", async () => {
    const { entry, file } = withSource(SOURCE);
    const deps = published([file], { pin: PIN });
    deps.verifyAttestation = signedIn("example-private/occupancy");
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      deps,
    );
    assert.equal(problems.length, 1);
    assert.match(
      problems[0],
      /^plugin occupancy 1\.0\.0: the artifact's build attestation does not verify as made by .* of example\/openbrf-occupancy .*: no attestations found for subject in example\/openbrf-occupancy$/,
    );
  });

  it("passes when that same attestation is made in its own repository", async () => {
    const { entry, file } = withSource(SOURCE);
    const deps = published([file], { pin: PIN });
    deps.verifyAttestation = signedIn("example/openbrf-occupancy");
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      deps,
    );
    assert.deepEqual(problems, []);
  });

  // The attestation fixes the record without proving it, so a record naming
  // a public repository would borrow that repository's name.
  it("fails when the source it names is public", async () => {
    const { entry, file } = withSource({
      ...SOURCE,
      repository: "https://github.com/openbrf/example-plugin",
    });
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([file], {
        pin: encode({
          ...SOURCE,
          repository: "https://github.com/openbrf/example-plugin",
        }),
        public: ["openbrf/example-plugin"],
      }),
    );
    assert.deepEqual(problems, [
      "plugin occupancy 1.0.0: the package's source.json names openbrf/example-plugin, which is public; a package whose source is public is released from its source repository, without source.json.",
    ]);
  });

  it("fails when GitHub cannot say whether the source is public", async () => {
    const { entry, file } = withSource(SOURCE);
    const deps = published([file], { pin: PIN });
    deps.repositoryIsPublic = async () => {
      throw new Error("GitHub answered 503.");
    };
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      deps,
    );
    assert.deepEqual(problems, [
      "plugin occupancy 1.0.0: whether example-private/occupancy, which the package's source.json names, is public could not be read: GitHub answered 503.",
    ]);
  });

  it("fails when its record is not the release repository's pin", async () => {
    const { entry, file } = withSource(SOURCE);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([file], {
        pin: encode({ ...SOURCE, commit: "f".repeat(40) }),
      }),
    );
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0],
      /the package's source\.json is not a copy of the one example\/openbrf-occupancy has at a{40}, the commit its attestation names;/,
    );
  });

  it("fails when its record is the pin written another way", async () => {
    const { entry, file } = withSource(JSON.stringify(SOURCE, null, 2));
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([file], { pin: PIN }),
    );
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /is not a copy of the one/);
  });

  it("fails when the release repository pins nothing at the attested commit", async () => {
    const { entry, file } = withSource(SOURCE);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([file]),
    );
    assert.deepEqual(problems, [
      `plugin occupancy 1.0.0: the package has a source.json, and example/openbrf-occupancy has none at ${ON_MAIN}, the commit its attestation names; a release-only repository pins the source it builds in a source.json of its own, and the package carries a copy.`,
    ]);
  });

  it("fails when the release repository pins a source and the package has no record", async () => {
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin), themeEntry(theme)] },
      published([pluginFile, themeFile], { pin: PIN }),
    );
    assert.deepEqual(problems, [
      `plugin occupancy 1.0.0: example/openbrf-occupancy pins a source in its source.json at ${ON_MAIN}, the commit its attestation names, and the package carries no copy of it.`,
      `theme example-theme 1.0.0: example/example-theme pins a source in its source.json at ${ON_MAIN}, the commit its attestation names, and the package carries no copy of it.`,
    ]);
  });

  it("compares the record with the pin at every attested source", async () => {
    const other = "c".repeat(40);
    const { entry, file } = withSource(SOURCE);
    const deps = published([file], {
      attestation: {
        ok: true,
        commits: [ON_MAIN, ON_MAIN, other, ON_MAIN],
        sources: [ON_MAIN, other],
      },
    });
    deps.defaultBranchHas = async () => ({ branch: "main", has: true });
    deps.sourcePinAt = async (_owner, _repo, commit) =>
      commit === ON_MAIN ? PIN : encode({ ...SOURCE, commit: other });
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      deps,
    );
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /is not a copy of the one .* has at c{40},/);
  });

  it("fails when the attestation names no source commit to read the pin at", async () => {
    for (const sources of [[], undefined, ["main"]]) {
      const { entry, file } = withSource(SOURCE);
      const deps = published([file], {
        pin: PIN,
        attestation: { ok: true, commits: [ON_MAIN, ON_MAIN], sources },
      });
      deps.sourcePinAt = async () => {
        throw new Error("not asked at a malformed commit");
      };
      const problems = await catalogProblems(
        { version: 1, entries: [entry] },
        deps,
      );
      assert.equal(problems.length, 1, JSON.stringify(sources));
      assert.match(
        problems[0],
        /names no source commit|names the source "main", which is not a commit id/,
      );
    }
  });

  it("fails when the pin cannot be read", async () => {
    const deps = published([pluginFile]);
    deps.sourcePinAt = async () => {
      throw new Error("raw.githubusercontent.com answered 503.");
    };
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.deepEqual(problems, [
      `plugin occupancy 1.0.0: the source.json of example/openbrf-occupancy at ${ON_MAIN} could not be read: raw.githubusercontent.com answered 503.`,
    ]);
  });

  const refused = [
    ["it is not JSON", "{", /is not readable JSON/],
    ["it is a list", [SOURCE], /is not an object naming/],
    [
      "it has a field a listing does not define",
      { ...SOURCE, branch: "main" },
      /has fields a listing does not define: "branch"\./,
    ],
    [
      "it names a field twice",
      `{"repository":"https://github.com/example-private/occupancy","commit":"${SOURCE.commit}","repository":"https://github.com/example-private/other"}`,
      /names the field "repository" more than once\./,
    ],
    [
      "it names a field twice, spelled with an escape",
      `{"repository":"https://github.com/example-private/occupancy","commit":"${SOURCE.commit}","\\u0063ommit":"${SOURCE.commit}"}`,
      /names the field "commit" more than once\./,
    ],
    [
      "it names no commit",
      { repository: SOURCE.repository },
      /names no `commit`/,
    ],
    [
      "it names no repository",
      { commit: SOURCE.commit },
      /names no `repository`/,
    ],
    [
      "the commit is abbreviated",
      { ...SOURCE, commit: SOURCE.commit.slice(0, 12) },
      /not a full commit id/,
    ],
    [
      "the commit is in capitals",
      { ...SOURCE, commit: SOURCE.commit.toUpperCase() },
      /not a full commit id/,
    ],
    [
      "the commit is a number",
      { ...SOURCE, commit: 1 },
      /not a full commit id/,
    ],
    [
      "the repository is not https",
      { ...SOURCE, repository: "http://github.com/example-private/occupancy" },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository carries credentials",
      {
        ...SOURCE,
        repository: "https://token@github.com/example-private/occupancy",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository carries a query",
      {
        ...SOURCE,
        repository: "https://github.com/example-private/occupancy?ref=main",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is not written as it reads",
      { ...SOURCE, repository: "https://GitHub.com/example-private/occupancy" },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is a host alone",
      { ...SOURCE, repository: "https://github.com/" },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is an owner alone",
      { ...SOURCE, repository: "https://github.com/example-private" },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is a path inside one",
      {
        ...SOURCE,
        repository: "https://github.com/example-private/occupancy/tree/main",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository ends in a slash",
      {
        ...SOURCE,
        repository: "https://github.com/example-private/occupancy/",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository ends in .git",
      {
        ...SOURCE,
        repository: "https://github.com/example-private/occupancy.git",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is encoded",
      {
        ...SOURCE,
        repository: "https://github.com/example-private/occ%75pancy",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is on another host",
      { ...SOURCE, repository: "https://gitlab.com/example-private/occupancy" },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is on www.github.com",
      {
        ...SOURCE,
        repository: "https://www.github.com/example/openbrf-occupancy",
      },
      /not https:\/\/github\.com\/<owner>\/<repository>\./,
    ],
    [
      "the repository is the release's own",
      {
        ...SOURCE,
        repository: "https://github.com/Example/openbrf-occupancy",
      },
      /names example\/openbrf-occupancy, the repository it is released from/,
    ],
  ];
  for (const [why, source, message] of refused) {
    it(`fails when its ${SOURCE_FILE} is refused because ${why}`, async () => {
      const { entry, file } = withSource(source);
      // The pin is the same bytes, so only the record's own rules refuse it.
      const problems = await catalogProblems(
        { version: 1, entries: [entry] },
        published([file], { pin: encode(source) }),
      );
      assert.equal(problems.length, 1, problems.join("\n"));
      assert.match(
        problems[0],
        /^plugin occupancy 1\.0\.0: the package's source\.json /,
      );
      assert.match(problems[0], message);
    });
  }

  it("quotes the fields it does not define, so none starts a line in the log", async () => {
    const fields = [
      "\n::error file=catalog.json::listing approved",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
    ];
    const source = {
      ...SOURCE,
      ...Object.fromEntries(fields.map((field) => [field, 1])),
    };
    const { entry, file } = withSource(source);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([file], { pin: encode(source) }),
    );
    assert.deepEqual(problems, [
      'plugin occupancy 1.0.0: the package\'s source.json has fields a listing does not define: "\\n::error file=catalog.json::listing approved", "b", "c", "d", "e" and 2 more.',
    ]);
  });

  it("writes every problem on one line", async () => {
    const deps = published([pluginFile]);
    deps.releaseOf = async () => {
      throw new Error("first\r\n::error::second");
    };
    const problems = await catalogProblems(
      { version: 1, entries: [pluginEntry(plugin)] },
      deps,
    );
    assert.deepEqual(problems, [
      "plugin occupancy 1.0.0: the release could not be read: first\\r\\n::error::second",
    ]);
  });

  it("fails a theme whose record is refused, and does not lint it", async () => {
    const source = { ...SOURCE, commit: "main" };
    const bytes = themeArchive(THEME_MANIFEST, { [SOURCE_FILE]: source });
    const entry = themeEntry(bytes);
    const problems = await catalogProblems(
      { version: 1, entries: [entry] },
      published([{ url: entry.artifact.url, bytes }], { pin: encode(source) }),
    );
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(
      problems[0],
      /^theme example-theme 1\.0\.0: .*"main", which is not a full commit id/,
    );
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
    [
      "a dot segment",
      good.replace("/example/", "/example/../example/"),
      "1.2.3",
    ],
    ["not a tarball", good.replace(".tgz", ".zip"), "1.2.3"],
    ["a raw file", "https://github.com/example/repo/raw/main/pkg.tgz", "1.2.3"],
  ]) {
    it(`is refused with ${why}`, () => {
      assert.equal(typeof releaseLocation(url, version), "string");
    });
  }
});
